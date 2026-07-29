/**
 * Consistent "hover to see the full date" formatting for the whole
 * app. Displayed compact strings ("22 May", "@0:23") are useful at
 * a glance but hide the day of week + year that operators sometimes
 * need. Callers set title={formatDateHover(iso)} on any element
 * that carries a compact date.
 */
export function formatDateHover(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()];
  const day = d.getUTCDate();
  const month = ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dayName}, ${day} ${month} ${year} · ${hh}:${mm} UTC`;
}
