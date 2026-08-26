'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, ArrowRight, CornerDownLeft, Maximize2, Loader2, X } from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import type { WorkspaceAgent, WorkspaceMessage } from '@/lib/types';

export default function QuickBarPage() {
  const [prompt, setPrompt] = useState('');
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [latestResponse, setLatestResponse] = useState<string>('');
  const [statusText, setStatusText] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on mount / window focus
  useEffect(() => {
    inputRef.current?.focus();
    const handleFocus = () => inputRef.current?.focus();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Fetch agents on load
  useEffect(() => {
    workspaceApi.listAgents().then((list) => {
      setAgents(list || []);
      const online = (list || []).filter((a) => a.status === 'online');
      if (online.length > 0) {
        setSelectedAgent(online[0].agentName);
      } else if (list && list.length > 0) {
        setSelectedAgent(list[0].agentName);
      }
    }).catch(() => {});
  }, []);

  // Handle global Esc key to dismiss quickbar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const bridge = (window as unknown as { electronBridge?: { hideQuickBar: () => void } }).electronBridge;
        bridge?.hideQuickBar();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSend = useCallback(async () => {
    const text = prompt.trim();
    if (!text || loading) return;

    setLoading(true);
    setStatusText('Sending command to agent...');
    setLatestResponse('');

    try {
      // 1. Create or resolve session
      let sId = activeSessionId;
      if (!sId) {
        const sessionRes = await workspaceApi.createChannel({
          participants: selectedAgent ? [selectedAgent] : undefined,
          master: selectedAgent || undefined,
        });
        sId = sessionRes.sessionId || `channel-quick-${Date.now()}`;
        setActiveSessionId(sId);
      }

      // 2. Send message with mention if needed
      const mentions = selectedAgent ? [selectedAgent] : [];
      await workspaceApi.sendMessage(
        sId,
        text,
        'user',
        mentions,
        undefined,
        'user',
        `quick-${Date.now()}`
      );

      setStatusText(`Agent @${selectedAgent || 'Agent'} is processing...`);
      setPrompt('');

      // 3. Poll for response
      let polls = 0;
      const pollInterval = setInterval(async () => {
        polls++;
        try {
          const pollRes = await workspaceApi.pollMessages(sId!);
          const msgs = pollRes.messages || [];
          if (msgs && msgs.length > 0) {
            const agentMsgs = msgs.filter((m: WorkspaceMessage) => m.senderType === 'agent' && m.messageType === 'chat');
            const statusMsgs = msgs.filter((m: WorkspaceMessage) => m.senderType === 'agent' && (m.messageType === 'status' || m.messageType === 'thinking'));
            
            if (statusMsgs.length > 0) {
              setStatusText(statusMsgs[statusMsgs.length - 1].content || 'Processing...');
            }

            if (agentMsgs.length > 0) {
              const last = agentMsgs[agentMsgs.length - 1];
              setLatestResponse(last.content);
              setLoading(false);
              setStatusText('');
              clearInterval(pollInterval);
            }
          }
        } catch {}

        if (polls > 30) {
          setLoading(false);
          setStatusText('');
          clearInterval(pollInterval);
        }
      }, 1200);

    } catch (err) {
      setLoading(false);
      setStatusText('Failed to dispatch command');
    }
  }, [prompt, loading, selectedAgent, activeSessionId]);

  const handleOpenFull = () => {
    const bridge = (window as unknown as { electronBridge?: { openMainWindow: (route?: string) => void; hideQuickBar: () => void } }).electronBridge;
    if (bridge) {
      bridge.openMainWindow(activeSessionId ? `/${activeSessionId}` : '/');
      bridge.hideQuickBar();
    }
  };

  const handleDismiss = () => {
    const bridge = (window as unknown as { electronBridge?: { hideQuickBar: () => void } }).electronBridge;
    bridge?.hideQuickBar();
  };

  return (
    <div className="flex flex-col w-full min-h-screen bg-transparent p-2 select-none overflow-hidden font-sans">
      <div className="flex flex-col w-full bg-[#121215]/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden [app-region:drag]">
        {/* Main Input Row */}
        <div className="flex items-center gap-2.5 px-3.5 py-3.5 [app-region:no-drag]">
          {/* Agent Picker Pill */}
          <div className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-white/80 font-medium">
            <Sparkles className="size-3.5 text-status-warning shrink-0" />
            <select
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="bg-transparent outline-none text-xs text-white cursor-pointer pr-1"
            >
              {agents.length === 0 && <option value="">Auto Route</option>}
              {agents.map((a) => (
                <option key={a.agentName} value={a.agentName} className="bg-[#18181b] text-white">
                  @{a.agentName}
                </option>
              ))}
            </select>
          </div>

          {/* Quick Prompt Input */}
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            placeholder="Command agents or ask anything... (Press Enter)"
            className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-white/40 outline-none"
            disabled={loading}
          />

          {/* Actions on right */}
          <div className="flex items-center gap-1 shrink-0">
            {loading ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-status-warning bg-status-warning/10 rounded-lg">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="text-2xs font-medium">Working</span>
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim()}
                className="size-7 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white/80 hover:text-white disabled:opacity-30 transition-all cursor-pointer"
                title="Send Command (Enter)"
              >
                <CornerDownLeft className="size-3.5" />
              </button>
            )}

            <button
              onClick={handleOpenFull}
              className="size-7 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer"
              title="Open full workspace"
            >
              <Maximize2 className="size-3.5" />
            </button>

            <button
              onClick={handleDismiss}
              className="size-7 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/50 hover:text-white transition-colors cursor-pointer"
              title="Dismiss (Esc)"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Live Status / Result Preview Bar */}
        {(statusText || latestResponse) && (
          <div className="px-3.5 pb-3 pt-1 border-t border-white/5 flex flex-col gap-1 text-xs [app-region:no-drag]">
            {statusText && (
              <div className="flex items-center gap-2 text-white/60 text-2xs">
                <span className="size-1.5 rounded-full bg-status-warning animate-pulse shrink-0" />
                <span className="truncate">{statusText}</span>
              </div>
            )}
            {latestResponse && (
              <div className="max-h-28 overflow-y-auto text-white/90 text-xs bg-black/30 rounded-lg p-2.5 leading-relaxed font-sans border border-white/5">
                <p className="whitespace-pre-wrap">{latestResponse}</p>
                <button
                  onClick={handleOpenFull}
                  className="mt-1.5 text-3xs text-status-warning hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <span>Continue in full workspace</span>
                  <ArrowRight className="size-3" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
