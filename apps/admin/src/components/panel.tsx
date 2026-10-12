/** A titled console card. `flush` drops the body padding for tables and lists that run edge to edge. */
export function Panel({ title, aside, flush, className, children }: { title: React.ReactNode; aside?: React.ReactNode; flush?: boolean; className?: string; children: React.ReactNode }) {
  return <section className={className ? `panel ${className}` : 'panel'}>
    <div className="panel-head"><h2>{title}</h2>{aside}</div>
    {flush ? children : <div className="panel-body">{children}</div>}
  </section>;
}
