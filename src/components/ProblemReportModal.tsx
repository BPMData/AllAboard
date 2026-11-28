import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Copy, Download, ExternalLink, LifeBuoy, Mail, Send, X } from 'lucide-react';
import {
  REPORT_CATEGORIES,
  REPORT_CONTACT_MAX,
  REPORT_INBOX,
  REPORT_TEXT_MAX,
  buildMailtoLink,
  buildPlainReport,
  buildPrivateEmail,
  buildPublicIssue,
  diagnosticLines,
  emptyReport,
  prepareReportForSending,
  type ProblemReportInput,
  type ReportDiagnostics,
  type ReportResponse,
} from '../lib/problemReport';

type Step = 'category' | 'details' | 'private' | 'review' | 'sending' | 'sent' | 'failed';

const STEP_NUMBER: Partial<Record<Step, number>> = { category: 1, details: 2, private: 3, review: 4 };

interface ProblemReportModalProps {
  /** Read once when the dialog opens. Only safe, non-classroom facts (see ReportDiagnostics). */
  getDiagnostics: () => ReportDiagnostics;
  /** Room code, PIN, roster names: removed from the description before it's shown or sent. Never sent. */
  redact?: string[];
  onClose: () => void;
  /** Tests and storybook-style use; defaults to POST /api/report. */
  submit?: (report: ProblemReportInput) => Promise<ReportResponse>;
}

async function postReport(report: ProblemReportInput): Promise<ReportResponse> {
  const res = await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
  try {
    return (await res.json()) as ReportResponse;
  } catch {
    return { ok: false, error: 'relay-failed' };
  }
}

const fieldClass =
  'w-full px-2.5 py-1.5 bg-slate-50 border border-[#CBD5E1] rounded-[2px] text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-brand-500';

export default function ProblemReportModal({
  getDiagnostics,
  redact = [],
  onClose,
  submit = postReport,
}: ProblemReportModalProps) {
  const [step, setStep] = useState<Step>('category');
  const [report, setReport] = useState<ProblemReportInput>(() => ({ ...emptyReport(), diagnostics: getDiagnostics() }));
  const [result, setResult] = useState<ReportResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const prepared = useMemo(() => prepareReportForSending(report, redact), [report, redact]);
  const publicIssue = useMemo(() => buildPublicIssue(prepared), [prepared]);
  const privateEmail = useMemo(() => buildPrivateEmail(prepared), [prepared]);
  const plainReport = useMemo(() => buildPlainReport(prepared), [prepared]);
  const busy = step === 'sending';

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    return () => returnFocusRef.current?.focus?.();
  }, []);

  // Each step starts with focus on its heading, so screen readers announce it and Tab starts at the top.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const update = (patch: Partial<ProblemReportInput>) => setReport((r) => ({ ...r, ...patch }));

  const handleSend = async () => {
    setStep('sending');
    setCopied(false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setResult({ ok: false, error: 'relay-failed', message: 'You seem to be offline.' });
      setStep('failed');
      return;
    }
    try {
      const res = await submit(prepared);
      setResult(res);
      setStep(res.ok ? 'sent' : 'failed');
    } catch {
      setResult({ ok: false, error: 'relay-failed', message: 'The report could not reach the server.' });
      setStep('failed');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plainReport);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([plainReport], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `allaboard-problem-report-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stepNumber = STEP_NUMBER[step];
  const headings: Record<Step, string> = {
    category: 'What went wrong?',
    details: 'What happened?',
    private: 'Anything else? (private)',
    review: 'Check what will be sent',
    sending: 'Sending…',
    sent: 'Thanks, your report was sent',
    failed: 'The report wasn’t sent',
  };

  const failureText = (() => {
    if (!result || result.ok) return '';
    const failure = result as Extract<ReportResponse, { ok: false }>;
    if (failure.error === 'not-configured') return 'Automatic sending isn’t set up yet.';
    if (failure.error === 'rate-limited') return 'Too many reports were sent just now.';
    return failure.message || 'Something went wrong while sending.';
  })();

  const navButtons = (onBack: (() => void) | null, next: React.ReactNode) => (
    <div className="flex items-center justify-between gap-2 pt-1">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
        >
          <ArrowLeft size={13} />
          <span>Back</span>
        </button>
      ) : (
        <span />
      )}
      {next}
    </div>
  );

  const primary = (label: string, onClick: () => void, disabled = false, icon?: React.ReactNode) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-[2px] border ${
        disabled
          ? 'bg-slate-100 border-[#CBD5E1] text-slate-400 cursor-not-allowed'
          : 'oh-btn-primary text-white cursor-pointer'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-950/60 flex items-center justify-center p-4"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="problem-report-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden text-slate-800 select-text"
      >
        <div className="oh-panel-header px-4 py-2.5 border-b border-[#CBD5E1] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <LifeBuoy size={16} className="text-brand-600 shrink-0" />
            <span className="font-display text-sm font-bold text-slate-900 truncate">Something not working?</span>
            {stepNumber && <span className="text-[11px] text-slate-500 whitespace-nowrap">Step {stepNumber} of 4</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close problem report"
            className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          <h2
            id="problem-report-title"
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-base font-semibold text-slate-900 focus:outline-none"
          >
            {headings[step]}
          </h2>

          {step === 'category' && (
            <>
              <p className="text-xs text-slate-600">
                Pick the closest one. Your class keeps going while you fill this in.
              </p>
              <fieldset className="space-y-1.5">
                <legend className="sr-only">What went wrong?</legend>
                {REPORT_CATEGORIES.map((c) => (
                  <label
                    key={c.id}
                    className={`flex items-start gap-2 px-2.5 py-1.5 rounded-[2px] border cursor-pointer ${
                      report.category === c.id ? 'border-brand-500 bg-brand-50' : 'border-[#CBD5E1] hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="problem-category"
                      value={c.id}
                      checked={report.category === c.id}
                      onChange={() => update({ category: c.id })}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{c.label}</span>
                      <span className="block text-[11px] text-slate-500">{c.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {navButtons(
                null,
                primary('Next', () => setStep('details'), !report.category)
              )}
            </>
          )}

          {step === 'details' && (
            <>
              <p className="text-xs text-slate-600">
                Skip anything you don’t know. Please don’t type names, room codes or PINs.
              </p>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">What happened? (optional)</span>
                <textarea
                  value={report.whatHappened}
                  onChange={(e) => update({ whatHappened: e.target.value })}
                  maxLength={REPORT_TEXT_MAX}
                  rows={3}
                  placeholder="Example: my drawing disappeared when I switched boards."
                  className={fieldClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">How can we make it happen again? (optional)</span>
                <textarea
                  value={report.steps}
                  onChange={(e) => update({ steps: e.target.value })}
                  maxLength={REPORT_TEXT_MAX}
                  rows={3}
                  placeholder="Example: 1. Join as a student 2. Teacher starts groups 3. Draw"
                  className={fieldClass}
                />
              </label>
              <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={report.keepDescriptionPrivate}
                  onChange={(e) => update({ keepDescriptionPrivate: e.target.checked })}
                  className="mt-0.5"
                />
                <span>Keep this description private (only the developer sees it, not the public report)</span>
              </label>
              {navButtons(
                () => setStep('category'),
                primary('Next', () => setStep('private'))
              )}
            </>
          )}

          {step === 'private' && (
            <>
              <p className="text-xs text-slate-600">
                Both boxes are optional and private. They go to the developer by email and never appear in the public
                report.
              </p>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">
                  Your email, to hear when it’s fixed (optional)
                </span>
                <input
                  type="text"
                  value={report.contact}
                  onChange={(e) => update({ contact: e.target.value })}
                  maxLength={REPORT_CONTACT_MAX}
                  autoComplete="email"
                  placeholder="Email address"
                  className={fieldClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-700">Anything else? (optional)</span>
                <textarea
                  value={report.comments}
                  onChange={(e) => update({ comments: e.target.value })}
                  maxLength={REPORT_TEXT_MAX}
                  rows={3}
                  className={fieldClass}
                />
              </label>
              {navButtons(
                () => setStep('details'),
                primary('Review', () => setStep('review'))
              )}
            </>
          )}

          {step === 'review' && (
            <>
              <p className="text-xs text-slate-600">
                Nothing has been sent yet. This is exactly what will go out when you press Send.
              </p>
              <section
                aria-labelledby="report-public-heading"
                className="rounded-[2px] border border-amber-300 bg-amber-50/60"
              >
                <h3
                  id="report-public-heading"
                  className="px-2.5 py-1.5 border-b border-amber-300 text-xs font-semibold text-amber-900"
                >
                  Public on GitHub: anyone can read this
                </h3>
                <pre
                  data-testid="report-public-preview"
                  className="px-2.5 py-2 text-[11px] leading-snug whitespace-pre-wrap break-words font-mono text-slate-800 max-h-48 overflow-y-auto"
                >
                  {`${publicIssue.title}\n\n${publicIssue.body}`}
                </pre>
              </section>
              <section
                aria-labelledby="report-private-heading"
                className="rounded-[2px] border border-[#CBD5E1] bg-slate-50"
              >
                <h3
                  id="report-private-heading"
                  className="px-2.5 py-1.5 border-b border-[#CBD5E1] text-xs font-semibold text-slate-800"
                >
                  Private: emailed to the developer only
                </h3>
                <dl data-testid="report-private-preview" className="px-2.5 py-2 text-[11px] space-y-1 text-slate-700">
                  {report.keepDescriptionPrivate && (
                    <div>
                      <dt className="font-semibold">Description</dt>
                      <dd className="whitespace-pre-wrap break-words">
                        {[prepared.whatHappened, prepared.steps].filter(Boolean).join('\n\n') || 'Not given.'}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-semibold">Contact</dt>
                    <dd className="break-words">{prepared.contact || 'Not given.'}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Anything else</dt>
                    <dd className="whitespace-pre-wrap break-words">{prepared.comments || 'Not given.'}</dd>
                  </div>
                  <div className="text-slate-500">
                    The email also repeats the public report. Subject: {privateEmail.subject}
                  </div>
                </dl>
              </section>
              <p className="text-[11px] text-slate-500">
                Never included: names, room codes, PINs, chat, drawings or worksheets.
                {diagnosticLines(prepared.diagnostics).length > 0 &&
                  ' The diagnostics above are about the app and this device only.'}
              </p>
              {navButtons(
                () => setStep('private'),
                primary('Send report', () => void handleSend(), false, <Send size={13} />)
              )}
            </>
          )}

          <div role="status" aria-live="polite" className="space-y-3">
            {step === 'sending' && <p className="text-sm text-slate-600">Sending your report…</p>}

            {step === 'sent' && result?.ok && (
              <>
                <p className="flex items-center gap-1.5 text-sm text-emerald-800">
                  <Check size={15} />
                  <span>The developer has your report.</span>
                </p>
                {result.issueUrl && (
                  <a
                    href={result.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-brand-700 underline"
                  >
                    <span>See the public report{result.issueNumber ? ` (#${result.issueNumber})` : ''}</span>
                    <ExternalLink size={13} />
                  </a>
                )}
                {navButtons(null, primary('Done', onClose))}
              </>
            )}

            {step === 'failed' && (
              <>
                <p className="flex items-start gap-1.5 text-sm text-red-800">
                  <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  <span>
                    {failureText} You can still send it yourself: copy or download it, then email it to {REPORT_INBOX}.
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
                  >
                    <Copy size={13} />
                    <span>{copied ? 'Copied' : 'Copy report'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
                  >
                    <Download size={13} />
                    <span>Download report</span>
                  </button>
                  <a
                    href={buildMailtoLink(prepared)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
                  >
                    <Mail size={13} />
                    <span>Open an email</span>
                  </a>
                </div>
                {navButtons(
                  () => setStep('review'),
                  primary('Try again', () => void handleSend())
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
