'use client';

import { SidebarContent } from './sidebar-content';
import { SidebarHeader } from './sidebar-header';
import { useLayout } from './layout-context';

export function Sidebar() {
  const { isSidebarOpen } = useLayout();

  return (
    <aside 
      className="fixed overflow-hidden bg-zinc-50 dark:bg-zinc-950 border-r border-zinc-200/50 dark:border-zinc-800/50 top-0 bottom-0 start-0 z-20 transition-all duration-350 flex flex-col shrink-0 shadow-xs"
      style={{ 
        width: isSidebarOpen ? '260px' : '0px',
        borderRightWidth: isSidebarOpen ? '1px' : '0px'
      }}
    >
      <div className="w-[260px] flex flex-col h-full shrink-0">
        <SidebarHeader />
        <SidebarContent />
      </div>
    </aside>
  );
}
