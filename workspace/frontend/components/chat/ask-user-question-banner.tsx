'use client';

import * as React from 'react';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import { HelpCircle, Check, Loader2, ShieldAlert, Sparkles, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface QuestionAnswer {
  question: string;
  answer: string[];
}

export interface AskUserQuestionBannerHandle {
  submitCustomAnswer: (text: string) => void;
}

interface AskUserQuestionBannerProps {
  questions: AskUserQuestionItem[];
  onSubmitAnswers: (answers: QuestionAnswer[]) => void;
  isSubmitting?: boolean;
  isTimedOut?: boolean;
  error?: string | null;
  className?: string;
}

export const AskUserQuestionBanner = forwardRef<
  AskUserQuestionBannerHandle,
  AskUserQuestionBannerProps
>(function AskUserQuestionBanner(
  { questions, onSubmitAnswers, isSubmitting = false, isTimedOut = false, error, className },
  ref
) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [multiSelectLabels, setMultiSelectLabels] = useState<Set<string>>(new Set());
  const [supplementaryNote, setSupplementaryNote] = useState<string>('');
  const [submittedChoice, setSubmittedChoice] = useState<string | null>(null);

  const toQuestionAnswers = useCallback(
    (rec: Record<string, string[]>): QuestionAnswer[] =>
      questions
        .filter((q) => rec[q.question] !== undefined)
        .map((q) => ({ question: q.question, answer: rec[q.question] })),
    [questions]
  );

  const currentIndex = useMemo(() => {
    for (let i = 0; i < questions.length; i++) {
      if (answers[questions[i].question] === undefined) return i;
    }
    return questions.length;
  }, [questions, answers]);

  const currentQuestion = currentIndex < questions.length ? questions[currentIndex] : null;
  const isAllAnswered = currentIndex >= questions.length;
  const disabled = isSubmitting || isTimedOut || Boolean(submittedChoice);

  // Distinguish between destructive action authorization vs design direction choice
  const isDestructive = useMemo(() => {
    if (!currentQuestion) return false;
    const text = (currentQuestion.question + ' ' + (currentQuestion.header || '')).toLowerCase();
    return /删除|移除|覆盖|清理|delete|remove|overwrite|destroy|rm\s|drop/.test(text);
  }, [currentQuestion]);

  const handleSelectOption = useCallback(
    (label: string) => {
      if (disabled || !currentQuestion) return;

      if (currentQuestion.multiSelect) {
        setMultiSelectLabels((prev) => {
          const next = new Set(prev);
          if (next.has(label)) {
            next.delete(label);
          } else {
            next.add(label);
          }
          return next;
        });
      } else {
        const finalAnswer = supplementaryNote.trim()
          ? `${label}（补充要求：${supplementaryNote.trim()}）`
          : label;
        setSubmittedChoice(finalAnswer);
        const newAnswers = {
          ...answers,
          [currentQuestion.question]: [finalAnswer],
        };
        setAnswers(newAnswers);

        if (currentIndex === questions.length - 1) {
          onSubmitAnswers(toQuestionAnswers(newAnswers));
        }
      }
    },
    [disabled, currentQuestion, answers, currentIndex, questions.length, onSubmitAnswers, toQuestionAnswers, supplementaryNote]
  );

  const handleConfirmMultiSelect = useCallback(() => {
    if (disabled || !currentQuestion) return;

    const labels = Array.from(multiSelectLabels);
    if (labels.length === 0) return;

    if (supplementaryNote.trim()) {
      labels.push(`补充要求：${supplementaryNote.trim()}`);
    }

    setSubmittedChoice(labels.join('; '));
    const newAnswers = {
      ...answers,
      [currentQuestion.question]: labels,
    };
    setAnswers(newAnswers);
    setMultiSelectLabels(new Set());

    if (currentIndex === questions.length - 1) {
      onSubmitAnswers(toQuestionAnswers(newAnswers));
    }
  }, [disabled, currentQuestion, multiSelectLabels, answers, currentIndex, questions.length, onSubmitAnswers, toQuestionAnswers, supplementaryNote]);

  useImperativeHandle(
    ref,
    () => ({
      submitCustomAnswer: (text: string) => {
        if (disabled || !currentQuestion || !text.trim()) return;
        setSubmittedChoice(text.trim());
        const newAnswers = {
          ...answers,
          [currentQuestion.question]: [text.trim()],
        };
        setAnswers(newAnswers);
        if (currentIndex === questions.length - 1) {
          onSubmitAnswers(toQuestionAnswers(newAnswers));
        }
      },
    }),
    [disabled, currentQuestion, answers, currentIndex, questions.length, onSubmitAnswers, toQuestionAnswers]
  );

  if ((isAllAnswered && !isSubmitting && !submittedChoice) || questions.length === 0) return null;

  return (
    <div className={cn('border-b border-border/80 bg-surface1/80 p-3 select-none', className)}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isDestructive ? (
            <ShieldAlert className="size-4 text-status-warning shrink-0" />
          ) : (
            <Sparkles className="size-4 text-primary shrink-0" />
          )}
          <span className="text-xs font-semibold text-foreground truncate">
            {isDestructive ? '操作授权确认' : '方案设计决策'}
          </span>
          <span className={cn(
            'text-3xs px-1.5 py-0.5 rounded-full font-mono',
            isDestructive ? 'bg-status-warning/15 text-status-warning' : 'bg-primary/15 text-primary'
          )}>
            {isDestructive ? '需明确授权' : '点击即选定'}
          </span>
          {questions.length > 1 && (
            <span className="text-foreground-muted text-3xs font-normal">
              ({Math.min(currentIndex + 1, questions.length)}/{questions.length})
            </span>
          )}
        </div>
        <p className="text-4xs text-foreground-muted hidden sm:block">
          选择后执行将继续推进；已执行操作修改将按新要求处理
        </p>
      </div>

      {/* Current Question */}
      {currentQuestion && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            {currentQuestion.header && (
              <span className="text-3xs font-medium font-mono text-foreground-muted bg-surface2 px-1.5 py-0.5 rounded border border-border/50">
                {currentQuestion.header}
              </span>
            )}
            {currentQuestion.multiSelect && (
              <span className="text-3xs text-foreground-extra-muted">支持多选</span>
            )}
          </div>

          <p className="text-xs font-medium text-foreground leading-relaxed">
            {currentQuestion.question}
          </p>

          {/* Supplementary requirement input */}
          {!submittedChoice && (
            <div className="flex items-center gap-1.5 bg-surface0/90 rounded-md border border-border/70 px-2 py-1 focus-within:border-primary/60">
              <MessageSquarePlus className="size-3 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={supplementaryNote}
                onChange={(e) => setSupplementaryNote(e.target.value)}
                placeholder="补充要求（可选，点击下方方案将一同提交）"
                disabled={disabled}
                className="w-full bg-transparent text-2xs text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
            </div>
          )}

          {/* Option buttons */}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {currentQuestion.options.map((opt) => {
              const isSelected = currentQuestion.multiSelect
                ? multiSelectLabels.has(opt.label)
                : submittedChoice?.startsWith(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleSelectOption(opt.label)}
                  title={opt.description}
                  className={cn(
                    'group relative inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-all cursor-pointer font-medium',
                    isSelected
                      ? 'border-primary bg-primary/15 text-primary shadow-xs font-semibold'
                      : 'border-border/80 bg-surface0 text-foreground-muted hover:border-primary/50 hover:text-foreground hover:bg-surface2',
                    disabled && 'opacity-60 cursor-not-allowed'
                  )}
                >
                  {isSelected && <Check className="size-3 text-primary shrink-0" />}
                  <span>{opt.label}</span>
                  {opt.description && (
                    <span className="text-3xs text-muted-foreground font-normal">
                      · {opt.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {currentQuestion.multiSelect && multiSelectLabels.size > 0 && !submittedChoice && (
            <div className="pt-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={handleConfirmMultiSelect}
                className="rounded-md bg-primary px-3 py-1 text-2xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
              >
                确认选定方案 ({multiSelectLabels.size})
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

      {(isSubmitting || submittedChoice) && (
        <div className="flex items-center gap-1.5 mt-2 text-2xs text-foreground-muted">
          {isSubmitting ? (
            <>
              <Loader2 className="size-3 animate-spin text-primary" />
              <span>正在提交决策给 Agent 并继续推进...</span>
            </>
          ) : (
            <>
              <Check className="size-3 text-status-success" />
              <span>已选定决策：{submittedChoice}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
});
