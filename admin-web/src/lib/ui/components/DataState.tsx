export function DataState({
  title,
  description,
  tone = "neutral",
  compact = false,
}: {
  title: string;
  description: string;
  tone?: "neutral" | "danger";
  compact?: boolean;
}) {
  return (
    <section className={`ui-data-state ui-data-state--${tone}${compact ? " ui-data-state--compact" : ""}`}>
      <h2 className="ui-section-title">{title}</h2>
      <p className="ui-copy">{description}</p>
    </section>
  );
}
