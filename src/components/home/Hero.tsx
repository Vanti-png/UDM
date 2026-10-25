import { useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';

/**
 * The Home headline: what to do, and one sentence about what it is for. It
 * stands in for the page title, which is why it is the `<h1>`. It has no
 * entrance of its own; the screen change it arrives with is the only fade.
 */
export function Hero() {
  const { t } = useTranslation();
  const Heading = 'h1';

  return (
    <div className="text-center">
      <Heading
        className={cn(
          'font-semibold leading-[1.12] tracking-[-0.03em] text-fg',
          'text-[34px]',
        )}
      >
        {t('hero.title')}
      </Heading>
      <p className="mt-2.5 text-[14px] text-fg-muted">{t('hero.subtitle')}</p>
    </div>
  );
}
