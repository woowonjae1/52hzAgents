'use client';

import { SidebarContent } from './sidebar-content';
import { SidebarHeader } from './sidebar-header';
import { useLayout } from './layout-context';

export function Sidebar() {
  const { isSidebarOpen } = useLayout();

  return (
    <aside 
      className="fixed overflow-hidden bg-surface-sidebar border-r border-border/80 top-0 bottom-0 start-0 z-20 transition-all duration-300 flex flex-col shrink-0 shadow-xs"
      style={{ 
        width: isSidebarOpen ? '320px' : '0px',
        borderRightWidth: isSidebarOpen ? '1px' : '0px'
      }}
    >
      <div className="w-[320px] flex flex-col h-full shrink-0">
        <SidebarHeader />
        <SidebarContent />
      </div>
    </aside>
  );
}
