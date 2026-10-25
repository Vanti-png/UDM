import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/*
 * The large title at the top of a page, with the page's own actions on
 * the right. It is the first child of the page's column and brings its own
 * vertical padding, so the page adds none above it:
 *
 *   <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
 *     <PageHeader title={t('downloads.title')} actions={<Button ... />} />
 *     ...
 *   </div>
 *
 * Home has no header: the hero is its title.
 */

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-end justify-between gap-4 pb-5 pt-9', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-[26px] font-semibold leading-[1.2] tracking-[-0.022em] text-fg">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[13.5px] text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
