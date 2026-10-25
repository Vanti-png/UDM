import { HistoryList } from '@/components/history/HistoryList';

/** The History screen: everything downloaded, newest first. */
export function HistoryPage({ onGoHome }: { onGoHome: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      <HistoryList onGoHome={onGoHome} />
    </div>
  );
}
