"use client";

interface Props {
  events: string[];
}

export default function EventLog({ events }: Props) {
  if (events.length === 0) return null;

  return (
    <div className="event-log">
      <h2>Event Log ({events.length})</h2>
      {[...events].reverse().map((ev, i) => {
        const colonIdx = ev.indexOf(":");
        const type = colonIdx > 0 ? ev.slice(0, colonIdx) : ev;
        const detail = colonIdx > 0 ? ev.slice(colonIdx + 1) : "";
        return (
          <div key={events.length - 1 - i} className="event-entry">
            <span className="event-type">{type}</span>
            {detail}
          </div>
        );
      })}
    </div>
  );
}
