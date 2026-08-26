'use client';

import * as React from 'react';
import { HelpCircle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EventLine } from './event-line';

export type ApprovalCardStatus = 'pending' | 'submitting' | 'answered';

export interface ApprovalCardOption {
  value: string;
  label: string;
  description?: string;
}

export interface ApprovalCardQuestion {
  id: string;
  title: string;
  options: ApprovalCardOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
}

export interface ApprovalCardProps {
  questions: ApprovalCardQuestion[];
  status?: ApprovalCardStatus;
  onSubmit?: (answers: Record<string, string>) => void;
  result?: string;
  className?: string;
}

/**
 * A question the agent is waiting on an answer to.
 *
 * `alwaysOpen` while pending, for the same reason as the tool-approval prompt: a
 * question the reader has to expand is a question that does not get answered.
 * Once answered it collapses to one line like everything else, because there is
 * nothing left to do with it.
 *
 * The emerald "answered" wash is gone. Success here is reported by the sentence
 * the agent gets back, which is already in `result`.
 */
export function ApprovalCard({
  questions,
  status = 'pending',
  onSubmit,
  result,
  className,
}: ApprovalCardProps) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [customInputs, setCustomInputs] = React.useState<Record<string, string>>({});
  const [selectedCustom, setSelectedCustom] = React.useState<Record<string, boolean>>({});

  const handleSelectOption = (questionId: string, value: string) => {
    if (status !== 'pending') return;
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    setSelectedCustom((prev) => ({ ...prev, [questionId]: false }));
  };

  const handleCustomChange = (questionId: string, val: string) => {
    if (status !== 'pending') return;
    setCustomInputs((prev) => ({ ...prev, [questionId]: val }));
    setSelectedCustom((prev) => ({ ...prev, [questionId]: true }));
    setAnswers((prev) => ({ ...prev, [questionId]: val }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (status !== 'pending') return;
    onSubmit?.(answers);
  };

  const isComplete = questions.every((q) => {
    const a = answers[q.id];
    return a && a.trim().length > 0;
  });

  const label =
    status === 'answered' ? 'Answered' : status === 'submitting' ? 'Sending your answer' : 'Needs your input';

  return (
    <EventLine
      className={className}
      icon={<HelpCircle />}
      label={label}
      detail={status === 'answered' ? result || 'Decision sent to the agent' : undefined}
      // The only `detail` in the app that is a sentence rather than a command,
      // so it is the only one that must not be set in the mono face.
      detailMono={false}
      state={status === 'submitting' ? 'running' : 'idle'}
      meta={questions.length > 1 ? questions.length : undefined}
      alwaysOpen={status !== 'answered'}
      defaultOpen={false}
    >
      <form onSubmit={handleSubmit} className="max-w-xl space-y-3 py-0.5">
        {questions.map((q) => {
          const selectedVal = answers[q.id];
          const isCustomActive = selectedCustom[q.id];

          return (
            <div key={q.id} className="space-y-1.5">
              <div className="text-xs font-medium text-foreground">{q.title}</div>

              <div className="flex flex-col gap-1">
                {q.options.map((opt) => {
                  const isSelected = selectedVal === opt.value && !isCustomActive;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={status !== 'pending'}
                      onClick={() => handleSelectOption(q.id, opt.value)}
                      className={cn(
                        'flex w-full items-baseline justify-between gap-2 rounded-base border px-2.5 py-1.5 text-left text-xs transition-colors',
                        isSelected
                          ? 'border-border-accent bg-surface2 text-foreground'
                          : 'cursor-pointer border-border bg-transparent text-foreground-muted hover:bg-surface2 hover:text-foreground',
                        status !== 'pending' && 'cursor-default opacity-70'
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{opt.label}</span>
                        {opt.description && (
                          <span className="mt-0.5 block text-3xs text-foreground-extra-muted">
                            {opt.description}
                          </span>
                        )}
                      </span>
                      {/*
                       * The selected mark is a glyph, not a filled radio dot.
                       * A 16px circle that is only ever empty or ticked is a
                       * checkmark with extra steps, and the empty state of it
                       * put a second border on every row.
                       */}
                      <span className="w-3 shrink-0 translate-y-px text-foreground">
                        {isSelected && <Check className="size-3" />}
                      </span>
                    </button>
                  );
                })}

                {q.allowCustom && (
                  <input
                    type="text"
                    disabled={status !== 'pending'}
                    value={customInputs[q.id] || ''}
                    onChange={(e) => handleCustomChange(q.id, e.target.value)}
                    placeholder={q.customPlaceholder || 'Describe another option…'}
                    className={cn(
                      'w-full rounded-base border px-2.5 py-1.5 text-xs transition-colors',
                      'bg-transparent text-foreground placeholder:text-foreground-extra-muted',
                      'focus:outline-hidden',
                      isCustomActive ? 'border-border-accent bg-surface2' : 'border-border'
                    )}
                  />
                )}
              </div>
            </div>
          );
        })}

        {status === 'pending' && (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="submit"
              disabled={!isComplete}
              className={cn(
                'rounded-base px-2.5 py-1 text-xs font-medium transition-opacity',
                isComplete
                  ? 'cursor-pointer bg-primary text-primary-foreground hover:opacity-90'
                  : 'cursor-not-allowed bg-surface3 text-foreground-extra-muted'
              )}
            >
              Confirm and continue
            </button>
            <span className="text-3xs text-foreground-extra-muted">
              Choose an option, or write your own
            </span>
          </div>
        )}
      </form>
    </EventLine>
  );
}
