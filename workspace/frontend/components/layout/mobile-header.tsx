'use client';

import { Hint } from '@/components/ui/hint';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Menu, MessageSquare, FileText, Globe, Plus, Network } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SidebarContent } from './sidebar-content';
import { useLayout, type ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

export function MobileHeader() {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const { viewMode, setViewMode, openMobileList, openNewThread } = useLayout();
  const { workspace } = useWorkspace();

  // Close sheet when clicking a session
  useEffect(() => {
    if (isSheetOpen) {
      const handler = () => setIsSheetOpen(false);
      // Give the session click time to propagate
      const timeout = setTimeout(() => {
        document.addEventListener('session-selected', handler, { once: true });
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [isSheetOpen]);

  const handleViewSwitch = (mode: ViewMode) => {
    setViewMode(mode);
    openMobileList();
  };

  // Open the shared agent picker so the user chooses who joins the new session.
  const handleNewThread = () => openNewThread();


  return (
    <>
      <header className="fixed top-0 start-0 end-0 z-50 flex items-center shrink-0 bg-background/95 backdrop-blur-sm border-b h-[var(--header-height-mobile)]">
        <div className="grow flex items-center justify-between gap-2 px-3">
          {/* Left: menu + logo + workspace name */}
          <div className="flex items-center gap-2 min-w-0">
            <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" mode="icon" size="sm" className="shrink-0">
                  <Menu className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent className="p-0 gap-0 w-[280px]" side="left" close={false}>
                <SheetHeader className="p-0 space-y-0">
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                </SheetHeader>
                <SheetBody className="flex grow p-0">
                  <SidebarContent />
                </SheetBody>
              </SheetContent>
            </Sheet>

            <div className="size-7 shrink-0 flex items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Network className="size-4" />
            </div>

            <span className="text-sm font-medium truncate">
              {workspace?.name || 'Workspace'}
            </span>
          </div>

          {/* Right: new thread button */}
          <Hint label="New Channel">
            <button
              onClick={handleNewThread}
              className="size-8 flex items-center justify-center rounded-lg bg-primary text-primary-foreground shrink-0"
            >
              <Plus className="size-4" />
            </button>
          </Hint>
        </div>
      </header>

      {/*
        No bottom tab bar. It held Channels (the thread list -- already the
        default pane and in the menu), Files (now a row in the sidebar menu)
        and Browser (removed), so what was left was one tab.
      */}
    </>
  );
}
