import { CircleDollarSign, Pickaxe } from "lucide-react";
import type { ReactNode } from "react";
import type { Deposit, Ship, WorldSnapshot } from "../../../../shared/types";

export function CargoWindow({
  snapshot,
  myShip,
  selectedAsteroidId,
  deposits,
  canUse,
  busyActions,
  onMine,
  onSell,
}: {
  snapshot: WorldSnapshot;
  myShip: Ship;
  selectedAsteroidId: string | undefined;
  deposits: Deposit[];
  canUse: boolean;
  busyActions: ReadonlySet<string>;
  onMine: (deposit: Deposit) => void;
  onSell: () => void;
}): ReactNode {
  const ratio = Math.max(0, Math.min(1, myShip.cargoMass / myShip.cargoCapacity));
  return (
    <>
      <div className="cargo-meter" data-testid="cargo-capacity-bar">
        <div style={{ width: `${ratio * 100}%` }} />
      </div>
      <div className="cargo-label" data-testid="cargo-capacity-label">
        {myShip.cargoMass.toFixed(1)} / {myShip.cargoCapacity} t
      </div>
      <div className="cargo-list">
        {snapshot.cargo.length === 0 ? (
          <span className="empty" data-testid="cargo-empty">
            hold empty
          </span>
        ) : null}
        {snapshot.cargo.map((item) => (
          <div key={item.mineral} className="cargo-item" data-testid={`cargo-item-${item.mineral}`}>
            <span>{item.mineral}</span>
            <b>{item.mass.toFixed(1)}t</b>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="primary-command"
        data-testid="cargo-sell"
        data-busy={busyActions.has("sell-cargo")}
        aria-busy={busyActions.has("sell-cargo")}
        disabled={!canUse || snapshot.cargo.length === 0}
        onClick={onSell}
      >
        <CircleDollarSign size={14} />
        Sell
      </button>
      {selectedAsteroidId !== undefined ? (
        <div className="deposit-list" data-testid="deposit-list">
          {deposits.map((deposit) => (
            <div className="deposit-row" key={deposit.id} data-testid={`deposit-row-${deposit.id}`}>
              <span>
                <b>{deposit.mineral}</b>
                <small>{deposit.remaining.toFixed(1)}t remaining</small>
              </span>
              <button
                type="button"
                data-testid={`deposit-mine-${deposit.id}`}
                data-busy={busyActions.has(`mine-${deposit.id}`)}
                aria-busy={busyActions.has(`mine-${deposit.id}`)}
                disabled={!canUse}
                onClick={() => onMine(deposit)}
              >
                <Pickaxe size={14} />
                Mine
              </button>
            </div>
          ))}
          {deposits.length === 0 ? <span className="empty">no discovered deposits</span> : null}
        </div>
      ) : null}
    </>
  );
}
