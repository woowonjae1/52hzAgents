'use client';

import * as React from 'react';
import {
  ApprovalCard as BeuiApprovalCard,
  type ApprovalCardAnswers,
  type ApprovalCardQuestion as BeuiApprovalCardQuestion,
} from '@/components/agents/approval-card';

/*
  THE ADAPTER, NOT A SECOND IMPLEMENTATION.

  beUI's card answers in `{ selected: string[], custom?: string }` per
  question, because it supports multi-select. Every caller here asks a
  single-choice question and expects one string back, so the adapter keeps
  the flat `Record<string, string>` contract and collapses beUI's shape into
  it — custom text wins over a selection, which is what "allowCustom" means.
*/

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

export function ApprovalCard({ questions, status, onSubmit, result, className }: ApprovalCardProps) {
  const mapped = React.useMemo<BeuiApprovalCardQuestion[]>(
    () =>
      questions.map((q) => ({
        id: q.id,
        title: q.title,
        options: q.options.map((o) => ({ value: o.value, label: o.label })),
        allowCustom: q.allowCustom,
        customPlaceholder: q.customPlaceholder,
        autoAdvance: true,
      })),
    [questions]
  );

  const handleSubmit = React.useCallback(
    (answers: ApprovalCardAnswers) => {
      if (!onSubmit) return;
      const flat: Record<string, string> = {};
      for (const [id, answer] of Object.entries(answers)) {
        const value = answer.custom?.trim() || answer.selected?.[0];
        if (value) flat[id] = value;
      }
      onSubmit(flat);
    },
    [onSubmit]
  );

  return (
    <BeuiApprovalCard
      questions={mapped}
      status={status}
      onSubmit={handleSubmit}
      result={result}
      className={className}
    />
  );
}
