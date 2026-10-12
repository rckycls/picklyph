import Link from 'next/link';

type Crumb = { href: string; label: string };

/** Console page title bar: ancestors as breadcrumbs, the current page as the heading, actions on the right. */
export function PageHeader({ crumbs = [], title, meta, actions }: { crumbs?: Crumb[]; title: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode }) {
  return <header className="page-header">
    {crumbs.length > 0 && <nav className="breadcrumbs" aria-label="Breadcrumb"><ol>{crumbs.map((crumb) => <li key={crumb.href}><Link href={crumb.href}>{crumb.label}</Link></li>)}</ol></nav>}
    <div className="page-header-row">
      <div className="page-title"><h1>{title}</h1>{meta && <p className="page-meta">{meta}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  </header>;
}
