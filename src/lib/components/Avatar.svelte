<script lang="ts">
  import type { Addr } from "$lib/types";
  import { initials, hashHue } from "$lib/util/misc";

  let { addr, size = 32 }: { addr: Addr | null | undefined; size?: number } = $props();
  const hue = $derived(hashHue((addr?.email ?? "?").toLowerCase()));
</script>

<span
  class="avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.38)}px"
  style:--h={hue}
  aria-hidden="true">{initials(addr)}</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: 50%;
    font-weight: 620;
    letter-spacing: 0.01em;
    color: oklch(0.86 0.06 var(--h));
    background: linear-gradient(145deg, oklch(0.42 0.07 var(--h)), oklch(0.32 0.05 var(--h)));
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.06);
  }
  :global([data-mode="light"]) .avatar {
    color: oklch(0.35 0.08 var(--h));
    background: linear-gradient(145deg, oklch(0.9 0.05 var(--h)), oklch(0.84 0.06 var(--h)));
  }
</style>
