import { Link, useLocation } from "react-router";
import { ENABLED_REPORT_SCOPES, type ReportScope } from "@aihot/contracts/site";
import { DOMAIN_LABELS } from "@aihot/contracts/taxonomy";
import { switchDomainHref } from "@aihot/contracts/http-policy";
import { setDomainPreference } from "../../lib/local-state";
import { IconCheck, IconChevronDown } from "../icons";
import { Menu } from "../ui/Menu";
import { useDomainNavigation } from "./nav";

const labelOf = (scope: ReportScope) => scope === "all" ? "全部领域" : DOMAIN_LABELS[scope];

// decision: keep the phone switch in the shared shell; not move selection to 更多 because leaving the current route first would lose its search and secondary filters.
export function DomainSwitcher({ sidebar = false }: { sidebar?: boolean }) {
  const location = useLocation();
  const { scope } = useDomainNavigation();
  return (
    <Menu
      label={`切换领域，当前${labelOf(scope)}`}
      align={sidebar ? "left" : "right"}
      triggerClassName={`flex h-11 items-center justify-between gap-2 px-2.5 text-[13px] font-semibold ${sidebar ? "w-full bg-bg-sunk" : "min-w-[100px]"}`}
      trigger={<><span>{labelOf(scope)}</span><IconChevronDown size={14} /></>}
    >
      {(close) => ENABLED_REPORT_SCOPES.map((target) => (
        <Link
          key={target}
          role="menuitemradio"
          aria-checked={scope === target}
          to={scope === target ? `${location.pathname}${location.search}${location.hash}` : switchDomainHref(location.pathname, new URLSearchParams(location.search), target)}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (scope === target) event.preventDefault();
            setDomainPreference(target);
            close();
          }}
          className={`flex h-11 items-center justify-between gap-5 px-3.5 text-[14px] transition-colors hover:bg-bg-sunk focus:bg-bg-sunk ${scope === target ? "font-semibold text-accent" : "text-ink-2"}`}
        >
          {labelOf(target)}
          {scope === target && <IconCheck size={15} />}
        </Link>
      ))}
    </Menu>
  );
}
