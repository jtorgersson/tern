<script lang="ts">
  let { size = 18 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
  <defs>
    <linearGradient id="tern-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--accent)" />
      <stop offset="1" stop-color="color-mix(in oklab, var(--accent) 55%, var(--fg))" />
    </linearGradient>
  </defs>
  <path
    fill="url(#tern-g)"
    d="M1.5 9.5c4.2-.2 7.6 1.3 10 4.4 1.6-3.7 5-6.3 11-7.4-3.9 2.2-6.4 5.3-7.6 9.3l2.6 4.7-3.9-2.6c-1.2.4-2.4.4-3.6 0C8 15.8 5.2 12.7 1.5 9.5z" />
</svg>
