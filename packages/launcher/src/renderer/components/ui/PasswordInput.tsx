import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "../../lib/utils"

export type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const { t } = useTranslation()
    const [visible, setVisible] = React.useState(false)
    const Icon = visible ? EyeOff : Eye
    return (
      <div className="relative flex items-center w-full">
        <input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn(
            "flex w-full rounded-(--r-lg) border border-(--border-c)",
            "bg-(--surface-1) text-(--fg) pl-3 pr-9 py-1.5 text-[13px] outline-none",
            "placeholder:text-(--fg-x-muted) transition-colors duration-150 hover:border-(--border-accent)",
            "focus:border-(--accent) focus:bg-(--surface-2)",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t("ui.passwordInput.hideValue") : t("ui.passwordInput.showValue")}
          title={visible ? t("ui.passwordInput.hide") : t("ui.passwordInput.show")}
          className="absolute right-2 flex items-center justify-center h-6 w-6 text-(--text-tertiary) hover:text-(--text-primary) transition-colors cursor-pointer"
        >
          <Icon strokeWidth={2} className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = "PasswordInput"

export { PasswordInput }
