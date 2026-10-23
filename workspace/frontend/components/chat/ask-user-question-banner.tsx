'use client';

import * as React from 'react';
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import { HelpCircle, Check, Loader2 } from 'lucide-react';
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
  const disabled = isSubmitting || isTimedOut;

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
        const newAnswers = {
          ...answers,
          [currentQuestion.question]: [label],
        };
        setAnswers(newAnswers);

        if (currentIndex === questions.length - 1) {
          onSubmitAnswers(toQuestionAnswers(newAnswers));
        }
      }
    },
    [disabled, currentQuestion, answers, currentIndex, questions.length, onSubmitAnswers, toQuestionAnswers]
  );

  const handleConfirmMultiSelect = useCallback(() => {
    if (disabled || !currentQuestion) return;

    const labels = Array.from(multiSelectLabels);
    if (labels.length === 0) return;

    const newAnswers = {
      ...answers,
      [currentQuestion.question]: labels,
    };
    setAnswers(newAnswers);
    setMultiSelectLabels(new Set());

    if (currentIndex === questions.length - 1) {
      onSubmitAnswers(toQuestionAnswers(newAnswers));
    }
  }, [disabled, currentQuestion, multiSelectLabels, answers, currentIndex, questions.length, onSubmitAnswers, toQuestionAnswers]);

  useImperativeHandle(
    ref,
    () => ({
      submitCustomAnswer: (text: string) => {
        if (disabled || !currentQuestion || !text.trim()) return;
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

  if ((isAllAnswered && !isSubmitting) || questions.length === 0) return null;

  return (
    <div className={cn('border-b border-border/80 bg-surface1/60 p-3 select-none', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle className="size-4 text-primary shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1">
          Agent Clarification Needed
          {questions.length > 1 && (
            <span className="text-foreground-muted ml-1.5 font-normal">
              ({Math.min(currentIndex + 1, questions.length)}/{questions.length})
            </span>
          )}
        </span>
      </div>

      {/* Current Question */}
      {currentQuestion && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {currentQuestion.header && (
              <span className="text-3xs font-medium font-mono text-foreground-muted bg-surface2 px-1.5 py-0.5 rounded border border-border/50">
                {currentQuestion.header}
              </span>
            )}
            {currentQuestion.multiSelect && (
              <span className="text-3xs text-foreground-extra-muted">Select all that apply</span>
            )}
          </div>

          <p className="text-xs font-medium text-foreground leading-relaxed">
            {currentQuestion.question}
          </p>

          <div className="flex flex-wrap gap-1.5 pt-1">
            {currentQuestion.options.map((opt) => {
              const isSelected = currentQuestion.multiSelect && multiSelectLabels.has(opt.label);
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
                      ? 'border-primary bg-primary/10 text-primary shadow-xs'
                      : 'border-border/80 bg-surface0 text-foreground-muted hover:border-primary/50 hover:text-foreground hover:bg-surface2',
                    disabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {isSelected && <Check className="size-3 text-primary shrink-0" />}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          {currentQuestion.multiSelect && multiSelectLabels.size > 0 && (
            <div className="pt-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={handleConfirmMultiSelect}
                className="rounded-md bg-primary px-3 py-1 text-2xs font-medium text-primary-foreground hover:bg-primary-hover transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
              >
                Confirm Selection ({multiSelectLabels.size})
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

      {isSubmitting && (
        <div className="flex items-center gap-1.5 mt-2 text-2xs text-foreground-muted">
          <Loader2 className="size-3 animate-spin text-primary" />
          <span>Submitting answer to agent...</span>
        </div>
      )}
    </div>
  );
});
