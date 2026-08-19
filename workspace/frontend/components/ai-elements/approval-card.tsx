'use client';

import * as React from 'react';
import { HelpCircle, Check, ArrowRight, Loader2, Send } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

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

  return (
    <div
      className={cn(
        'w-full max-w-xl rounded-2xl border border-border/80 bg-surface1/95 backdrop-blur-md p-4 shadow-sm transition-all',
        status === 'answered' && 'border-emerald-500/30 bg-emerald-500/[0.03]',
        className
      )}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {questions.map((q) => {
          const selectedVal = answers[q.id];
          const isCustomActive = selectedCustom[q.id];

          return (
            <div key={q.id} className="space-y-2.5">
              {/* Question Title Header */}
              <div className="flex items-center gap-2 text-foreground font-medium text-xs">
                <HelpCircle className="size-4 text-primary shrink-0" />
                <span>{q.title}</span>
              </div>

              {/* Option Pills / Radio Cards */}
              <div className="grid grid-cols-1 gap-1.5">
                {q.options.map((opt) => {
                  const isSelected = selectedVal === opt.value && !isCustomActive;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={status !== 'pending'}
                      onClick={() => handleSelectOption(q.id, opt.value)}
                      className={cn(
                        'w-full text-left px-3 py-2 rounded-xl border text-xs transition-all flex items-center justify-between gap-2',
                        isSelected
                          ? 'border-primary bg-primary/10 text-foreground font-semibold shadow-2xs'
                          : 'border-border/60 bg-surface2/60 hover:bg-surface2 text-muted-foreground hover:text-foreground cursor-pointer',
                        status !== 'pending' && 'cursor-default opacity-85'
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{opt.label}</div>
                        {opt.description && (
                          <div className="text-[10.5px] text-muted-foreground font-normal mt-0.5">
                            {opt.description}
                          </div>
                        )}
                      </div>
                      <div
                        className={cn(
                          'size-4 rounded-full border flex items-center justify-center shrink-0 transition-colors',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border/80 bg-background'
                        )}
                      >
                        {isSelected && <Check className="size-2.5" />}
                      </div>
                    </button>
                  );
                })}

                {/* Custom write-in option if allowed */}
                {q.allowCustom && (
                  <div
                    className={cn(
                      'px-3 py-1.5 rounded-xl border transition-all text-xs flex items-center gap-2',
                      isCustomActive
                        ? 'border-primary bg-primary/10'
                        : 'border-border/60 bg-surface2/40'
                    )}
                  >
                    <input
                      type="text"
                      disabled={status !== 'pending'}
                      value={customInputs[q.id] || ''}
                      onChange={(e) => handleCustomChange(q.id, e.target.value)}
                      placeholder={q.customPlaceholder || '输入其他选项说明…'}
                      className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden"
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Footer actions / result banner */}
        <div className="flex items-center justify-between pt-1 border-t border-border/40 text-xs">
          {status === 'answered' ? (
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium text-xs">
              <Check className="size-3.5" />
              <span>{result || '决策已提交并同步给 Agent'}</span>
            </div>
          ) : status === 'submitting' ? (
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              <span>正在提交选择…</span>
            </div>
          ) : (
            <>
              <span className="text-[11px] text-muted-foreground">
                请选择或输入决策方案
              </span>
              <button
                type="submit"
                disabled={!isComplete}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-xs transition-all',
                  isComplete
                    ? 'bg-primary text-primary-foreground hover:opacity-90 cursor-pointer'
                    : 'bg-surface3 text-muted-foreground opacity-50 cursor-not-allowed'
                )}
              >
                <span>确认并继续</span>
                <ArrowRight className="size-3" />
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
