interface SectionHeaderProps {
  label: string;
}

export function SectionHeader({ label }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <span className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </span>
    </div>
  );
}