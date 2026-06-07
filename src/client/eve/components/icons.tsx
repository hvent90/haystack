import { House, MessageSquare, Pickaxe, ScanLine, Ship as ShipIcon, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type { WindowKey } from "../types";

export function WindowIcon({ windowKey, size }: { windowKey: WindowKey; size: number }): ReactNode {
  switch (windowKey) {
    case "flight":
      return <ShipIcon size={size} />;
    case "scanner":
      return <ScanLine size={size} />;
    case "cargo":
      return <Pickaxe size={size} />;
    case "comms":
      return <MessageSquare size={size} />;
    case "character":
      return <UserRound size={size} />;
    case "bases":
      return <House size={size} />;
  }
}
