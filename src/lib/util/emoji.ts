/** Textarea selections use UTF-16 offsets, including when the draft contains emoji. */
export function insertEmoji(text: string, emoji: string, start = text.length, end = start, maxLength = Infinity) {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const value = text.slice(0, from) + emoji + text.slice(to);
  return value.length <= maxLength ? { value, caret: from + emoji.length } : { value: text, caret: to };
}

export const EMOJIS = [
  ["😀", "grinning happy smile"], ["😊", "smile happy pleased"], ["😂", "laugh tears joy"],
  ["🤣", "rolling laugh funny"], ["🙂", "slight smile"], ["😉", "wink"],
  ["😍", "love heart eyes"], ["🥰", "love hearts"], ["😎", "cool sunglasses"],
  ["🤔", "thinking question"], ["😅", "sweat smile relief"], ["😇", "angel innocent"],
  ["🥳", "party celebration"], ["🤩", "star excited"], ["😢", "sad crying"],
  ["😭", "cry sob"], ["😮", "surprise"], ["😬", "grimace awkward"],
  ["🙃", "upside down smile"], ["😴", "sleep tired"], ["🤗", "hug"],
  ["🫡", "salute understood"], ["👍", "thumbs up yes approve"], ["👎", "thumbs down no"],
  ["👏", "clap applause"], ["🙌", "raised hands hooray"], ["🙏", "thanks please pray"],
  ["👋", "wave hello goodbye"], ["🤝", "handshake agreement"], ["💪", "strong muscle"],
  ["👌", "okay perfect"], ["✌️", "peace victory"], ["🤞", "crossed fingers luck"],
  ["❤️", "red heart love"], ["💙", "blue heart"], ["💚", "green heart"],
  ["💛", "yellow heart"], ["🧡", "orange heart"], ["💜", "purple heart"],
  ["🎉", "celebrate party"], ["🎊", "confetti"], ["✨", "sparkles magic"],
  ["🚀", "rocket launch"], ["🔥", "fire great"], ["💯", "hundred perfect"],
  ["✅", "check done complete"], ["❌", "cross no cancel"], ["⚠️", "warning attention"],
  ["💡", "idea light bulb"], ["🎯", "target goal"], ["📌", "pin important"],
  ["📅", "calendar date"], ["⏰", "alarm time"], ["📎", "attachment paperclip"],
  ["📝", "notes memo"], ["💬", "chat speech"], ["👀", "eyes looking"],
  ["☕", "coffee break"], ["🍰", "cake"], ["🎂", "birthday cake"],
  ["🌟", "star"], ["🌈", "rainbow"], ["🌻", "sunflower"],
  ["🎁", "gift present"], ["🏆", "trophy win"], ["🌍", "world earth"],
] as const;
