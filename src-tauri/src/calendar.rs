//! Calendar: cached event window, invitations, free-slot search and meeting reminders.
use crate::graph;
use crate::model::*;
use crate::state::AppState;
use anyhow::Result;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc, Weekday};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Window kept fresh by the periodic sync. Anything outside is fetched on demand (`fetch_range`).
pub const WINDOW_BACK_DAYS: i64 = 14;
pub const WINDOW_AHEAD_DAYS: i64 = 45;
const FMT: &str = "%Y-%m-%dT%H:%M:%S";

/// IANA name of the system zone (what Graph renders event times in).
pub fn local_tz() -> String {
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let s = target.to_string_lossy();
        if let Some(i) = s.find("zoneinfo/") {
            return s[i + 9..].to_string();
        }
    }
    std::env::var("TZ").ok().filter(|t| !t.is_empty()).unwrap_or_else(|| "UTC".into())
}

pub fn now_local() -> NaiveDateTime {
    Local::now().naive_local()
}

fn fmt(t: NaiveDateTime) -> String {
    t.format(FMT).to_string()
}

pub fn parse(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(&s.chars().take(19).collect::<String>(), FMT)
        .ok()
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap()))
}

fn to_utc_str(t: NaiveDateTime) -> String {
    match Local.from_local_datetime(&t).earliest() {
        Some(l) => l.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        None => t.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    }
}

/// Refreshes the calendar list and downloads [from, to) from every calendar of the account into the cache.
async fn pull_range(st: &AppState, acc: &Account, from: NaiveDateTime, to: NaiveDateTime) -> Result<Vec<CalEvent>> {
    let tz = local_tz();
    let (from_utc, to_utc) = (to_utc_str(from), to_utc_str(to));
    // Calendars list: tenants that block it still get the default calendar.
    let cals = match graph::calendars(st, &acc.id).await {
        Ok(c) if !c.is_empty() => c,
        Ok(_) => vec![],
        Err(e) => {
            log::warn!("calendars list failed for {}: {e:#}", acc.email);
            st.db.calendars(Some(&acc.id)).unwrap_or_default()
        }
    };
    let mut events = Vec::new();
    if cals.is_empty() {
        events = graph::calendar_view(st, &acc.id, None, &tz, &from_utc, &to_utc).await?;
    } else {
        st.db.replace_calendars(&acc.id, &cals)?;
        let mut first_err: Option<anyhow::Error> = None;
        for c in &cals {
            match graph::calendar_view(st, &acc.id, Some(&c.id), &tz, &from_utc, &to_utc).await {
                Ok(list) => events.extend(list),
                // A single broken shared calendar must not hide the others.
                Err(e) => {
                    log::warn!("calendarView failed for {} / {}: {e:#}", acc.email, c.name);
                    if c.is_default {
                        first_err.get_or_insert(e);
                    }
                }
            }
        }
        if let (Some(e), true) = (first_err, events.is_empty()) {
            return Err(e);
        }
    }
    // The same event can show up in two calendars only for shared copies; keep the first.
    let mut seen = HashSet::new();
    events.retain(|e| seen.insert(e.id.clone()));
    events.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    st.db.replace_events(&acc.id, &fmt(from), &fmt(to), &events)?;
    Ok(events)
}

pub async fn sync_account(app: &AppHandle, st: &AppState, acc: &Account) -> Result<()> {
    let now = now_local();
    let from = (now - Duration::days(WINDOW_BACK_DAYS)).date().and_hms_opt(0, 0, 0).unwrap();
    let to = (now + Duration::days(WINDOW_AHEAD_DAYS)).date().and_hms_opt(0, 0, 0).unwrap();
    pull_range(st, acc, from, to).await?;
    let _ = app.emit("calendar://changed", serde_json::json!({ "accountId": acc.id }));
    Ok(())
}

/// On-demand download of an arbitrary range (navigating months ahead / back). Returns the cached events for it.
pub async fn fetch_range(app: &AppHandle, st: &AppState, from: &str, to: &str, account_id: Option<&str>) -> Result<Vec<CalEvent>> {
    let f = parse(from).ok_or_else(|| anyhow::anyhow!("bad from"))?;
    let t = parse(to).ok_or_else(|| anyhow::anyhow!("bad to"))?;
    if t <= f || (t - f).num_days() > 400 {
        anyhow::bail!("range must be between 1 day and 400 days");
    }
    let accounts: Vec<Account> = st.db.accounts()?.into_iter().filter(|a| account_id.map_or(true, |id| a.id == id)).collect();
    let mut changed = false;
    for acc in &accounts {
        match pull_range(st, acc, f, t).await {
            Ok(_) => changed = true,
            Err(e) => log::warn!("calendar range fetch failed for {}: {e:#}", acc.email),
        }
    }
    if changed {
        let _ = app.emit("calendar://changed", serde_json::json!({ "accountId": Value::Null, "range": [from, to] }));
    }
    Ok(st.db.events(from, to, account_id)?)
}

pub async fn invite(st: &AppState, message_id: &str) -> Result<Option<InviteInfo>> {
    let Some((account_id, _, _)) = st.db.message_meta(message_id)? else { return Ok(None) };
    let tz = local_tz();
    let (meeting_type, event) = match graph::event_message(st, &account_id, &tz, message_id).await {
        Ok(r) => r,
        // Not an eventMessage (or the event is gone): nothing to show.
        Err(e) if e.downcast_ref::<graph::GraphError>().is_some_and(|g| g.status == 400 || g.status == 404) => return Ok(None),
        Err(e) => return Err(e),
    };
    if meeting_type == "none" && event.is_none() {
        return Ok(None);
    }
    st.db.set_meeting_type(message_id, &meeting_type)?;
    let conflicts = match &event {
        Some(ev) => {
            // Keep the cache in step with what the invitation says.
            st.db.upsert_event(ev)?;
            st.db.conflicts(ev)?
        }
        None => vec![],
    };
    Ok(Some(InviteInfo { meeting_type, event, conflicts }))
}

fn parse_hm(s: &str, default: NaiveTime) -> NaiveTime {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").unwrap_or(default)
}

/// Concrete `duration`-long proposals inside work hours on weekdays, avoiding `busy`, at most 3 per day.
pub fn propose_slots(
    busy: &[(NaiveDateTime, NaiveDateTime)],
    from: NaiveDateTime,
    to: NaiveDateTime,
    now: NaiveDateTime,
    duration_mins: i64,
    work_start: NaiveTime,
    work_end: NaiveTime,
    max: usize,
) -> Vec<FreeSlot> {
    let dur = Duration::minutes(duration_mins.clamp(5, 24 * 60));
    let step = Duration::minutes(15);
    let round_up = |t: NaiveDateTime| {
        let m = t.minute() as i64;
        let extra = (15 - m % 15) % 15;
        (t + Duration::minutes(extra)).with_second(0).unwrap().with_nanosecond(0).unwrap()
    };
    let mut out = Vec::new();
    let mut day = from.date();
    while day <= to.date() && out.len() < max {
        if !matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            let lo = round_up([day.and_time(work_start), from, now].into_iter().max().unwrap());
            let hi = [day.and_time(work_end), to].into_iter().min().unwrap();
            let mut t = lo;
            let mut per_day = 0;
            while t + dur <= hi && per_day < 3 && out.len() < max {
                let end = t + dur;
                if busy.iter().any(|(bs, be)| *bs < end && *be > t) {
                    t += step;
                } else {
                    out.push(FreeSlot { start: fmt(t), end: fmt(end) });
                    per_day += 1;
                    // Spread proposals out instead of listing every adjacent slot.
                    t = end + Duration::minutes(60);
                }
            }
        }
        day = day.succ_opt().unwrap();
    }
    out
}


pub async fn free_slots(st: &AppState, q: &FreeSlotQuery) -> Result<Vec<FreeSlot>> {
    let settings = st.settings.read().unwrap().clone();
    let (ws, we) = crate::settings::work_hours(&settings);
    let work_start = parse_hm(q.work_start.as_deref().unwrap_or(&ws), NaiveTime::from_hms_opt(9, 0, 0).unwrap());
    let work_end = parse_hm(q.work_end.as_deref().unwrap_or(&we), NaiveTime::from_hms_opt(17, 0, 0).unwrap());
    let from = parse(&q.from).ok_or_else(|| anyhow::anyhow!("bad from"))?;
    let to = parse(&q.to).ok_or_else(|| anyhow::anyhow!("bad to"))?;
    let tz = local_tz();
    let me = st.db.account(&q.account_id)?.map(|a| a.email).unwrap_or_default();

    let mut emails: Vec<String> = vec![me.clone()];
    emails.extend(q.attendees.iter().filter(|e| !e.eq_ignore_ascii_case(&me)).cloned());

    let interval = 15;
    let mut busy: Vec<(NaiveDateTime, NaiveDateTime)> = Vec::new();
    match graph::get_schedule(st, &q.account_id, &tz, &emails, &fmt(from), &fmt(to), interval).await {
        Ok(views) if !views.is_empty() => {
            for view in views {
                for (i, ch) in view.chars().enumerate() {
                    if ch != '0' {
                        let s = from + Duration::minutes(i as i64 * interval);
                        busy.push((s, s + Duration::minutes(interval)));
                    }
                }
            }
        }
        // Personal accounts (and tenants that block free/busy): fall back to our own cached calendar.
        Ok(_) | Err(_) => {
            for e in st.db.events(&fmt(from), &fmt(to), Some(&q.account_id))? {
                if e.is_cancelled || e.response == "declined" || e.show_as == "free" || e.is_all_day {
                    continue;
                }
                if let (Some(s), Some(en)) = (parse(&e.start), parse(&e.end)) {
                    busy.push((s, en));
                }
            }
        }
    }
    Ok(propose_slots(&busy, from, to, now_local(), q.duration_mins, work_start, work_end, 12))
}

/// Desktop notification shortly before each meeting.
pub fn start_reminders(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let st = app.state::<Arc<AppState>>().inner().clone();
        let mut notified: HashSet<String> = HashSet::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let minutes = crate::settings::reminder_minutes(&st.settings.read().unwrap());
            if minutes == 0 {
                continue;
            }
            let now = now_local();
            let until = now + Duration::minutes(minutes);
            let Ok(events) = st.db.events(&fmt(now), &fmt(until + Duration::hours(1)), None) else { continue };
            for e in events {
                let Some(start) = parse(&e.start) else { continue };
                if start < now || start > until || e.is_all_day || e.is_cancelled || e.response == "declined" {
                    continue;
                }
                if !notified.insert(e.id.clone()) {
                    continue;
                }
                let mins = (start - now).num_minutes().max(0);
                let when = if mins == 0 { "Starting now".to_string() } else { format!("Starts in {mins} min") };
                let place = e.location.clone().or_else(|| e.is_online.then(|| "Teams meeting".to_string()));
                let body = match place {
                    Some(p) => format!("{when} · {p}"),
                    None => when,
                };
                let _ = app.notification().builder().title(&e.subject).body(body).show();
            }
            if notified.len() > 500 {
                notified.clear();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> NaiveDateTime {
        parse(s).unwrap()
    }

    #[test]
    fn proposes_weekday_work_hour_slots_around_busy_blocks() {
        // Tue 2026-10-06; busy 10:00–11:30 and 13:00–14:00
        let busy = vec![(t("2026-10-06T10:00:00"), t("2026-10-06T11:30:00")), (t("2026-10-06T13:00:00"), t("2026-10-06T14:00:00"))];
        let slots = propose_slots(
            &busy,
            t("2026-10-06T00:00:00"),
            t("2026-10-07T23:59:00"),
            t("2026-10-06T09:20:00"), // "now": nothing before 09:30
            30,
            NaiveTime::from_hms_opt(9, 0, 0).unwrap(),
            NaiveTime::from_hms_opt(17, 0, 0).unwrap(),
            12,
        );
        let starts: Vec<&str> = slots.iter().map(|s| s.start.as_str()).collect();
        assert_eq!(starts[0], "2026-10-06T09:30:00");
        assert!(starts.iter().all(|s| !s.starts_with("2026-10-06T10:") && !s.starts_with("2026-10-06T13:")), "{starts:?}");
        assert_eq!(slots.iter().filter(|s| s.start.starts_with("2026-10-06")).count(), 3);
        assert!(slots.iter().any(|s| s.start.starts_with("2026-10-07T09:00")));
        for s in &slots {
            assert_eq!((t(&s.end) - t(&s.start)).num_minutes(), 30);
        }
    }

    #[test]
    fn skips_weekends() {
        let slots = propose_slots(&[], t("2026-10-10T00:00:00"), t("2026-10-11T23:00:00"), t("2026-10-01T00:00:00"), 60,
            NaiveTime::from_hms_opt(9, 0, 0).unwrap(), NaiveTime::from_hms_opt(17, 0, 0).unwrap(), 12);
        assert!(slots.is_empty());
    }

    #[test]
    fn tz_detected() {
        let tz = local_tz();
        assert!(!tz.is_empty());
        println!("tz={tz}");
    }
}
