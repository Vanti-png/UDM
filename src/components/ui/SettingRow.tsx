import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { ListGroup, ListGroupLabel } from './ListGroup';
import { Toggle } from './Toggle';

interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  /** Renders the control on its own line, for wide inputs. */
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}

export function SettingRow({
  title,
  description,
  control,
  stacked = false,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex gap-4 px-4 py-3',
        // Wrapping lets a wide control drop under its label on a narrow screen;
        // the label's minimum width is what decides when that happens.
        stacked ? 'flex-col' : 'flex-wrap items-center justify-between',
        className,
      )}
    >
      <div className={cn(stacked ? 'w-full min-w-0' : 'min-w-[min(100%,12rem)] flex-1')}>
        <RowText title={title} description={description} />
      </div>
      {control && <div className={cn('max-w-full shrink-0', stacked && 'w-full')}>{control}</div>}
      {children}
    </div>
  );
}

function RowText({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <>
      <div className="text-[13.5px] text-fg">{title}</div>
      {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</p>}
    </>
  );
}

interface ToggleRowProps {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** A setting that is only on or off. */
export function ToggleRow({ title, description, checked, onChange, disabled = false }: ToggleRowProps) {
  return (
    <SettingRow
      title={title}
      description={description}
      control={<Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />}
    />
  );
}

export function SettingGroup({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      {title && (
        <div>
          <ListGroupLabel>{title}</ListGroupLabel>
          {description && <p className="mt-0.5 px-4 text-[12.5px] text-fg-muted">{description}</p>}
        </div>
      )}
      <ListGroup>{children}</ListGroup>
    </section>
  );
}
