import { DataState } from "../../lib/ui/components/DataState";

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h2 className="ui-section-title">{title}</h2>
        <p className="ui-copy">This route is intentionally placeholder-only in the foundation slice.</p>
      </header>
      <DataState tone="neutral" title={`${title} foundation ready`} description={description} />
    </section>
  );
}
