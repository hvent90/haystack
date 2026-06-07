import { House, Radio } from "lucide-react";
import type { ReactNode } from "react";
import type { FieldDiagnostic, Ship, UpgradeSystem, WorldSnapshot } from "../../../../shared/types";
import { upgradeLabels, upgradeSystems } from "../../constants";
import { upgradeCostEstimate, upgradeEffect } from "../../upgrades";

export function BasesWindow({
  snapshot,
  myShip,
  canUse,
  busyActions,
  fieldStats,
  onDeploy,
  onInspectField,
  onUpgrade,
}: {
  snapshot: WorldSnapshot;
  myShip: Ship;
  canUse: boolean;
  busyActions: ReadonlySet<string>;
  fieldStats: FieldDiagnostic | null;
  onDeploy: () => void;
  onInspectField: () => void;
  onUpgrade: (system: UpgradeSystem) => void;
}): ReactNode {
  const credits = snapshot.me?.credits ?? 0;
  return (
    <>
      <div className="base-actions">
        <button
          type="button"
          className="primary-command"
          data-testid="base-deploy-hab"
          data-busy={busyActions.has("deploy-base")}
          aria-busy={busyActions.has("deploy-base")}
          disabled={!canUse || credits < 500}
          onClick={onDeploy}
        >
          <House size={14} />
          Deploy HAB
        </button>
        <button
          type="button"
          className="secondary-command"
          data-testid="base-field-index"
          data-busy={busyActions.has("field-index")}
          aria-busy={busyActions.has("field-index")}
          disabled={!canUse}
          onClick={onInspectField}
        >
          <Radio size={14} />
          Field Index
        </button>
      </div>
      {fieldStats !== null ? (
        <div className="field-stats" data-testid="field-stats">
          {fieldStats.totalAsteroids.toLocaleString()} rocks, {fieldStats.cellsVisited} cells,{" "}
          {fieldStats.materializedAsteroids} materialized
        </div>
      ) : null}
      <div className="structure-list">
        {snapshot.structures
          .filter((structure) => structure.discovered)
          .map((structure) => (
            <div
              key={structure.id}
              className={
                structure.ownerPilotId === myShip.pilotId
                  ? "structure-item owned"
                  : "structure-item"
              }
              data-testid={`structure-row-${structure.id}`}
            >
              <span>
                <strong>{structure.name}</strong>
                <small>{structure.kind}</small>
              </span>
              {structure.hidden ? (
                <b data-testid={`structure-hidden-${structure.id}`}>hidden</b>
              ) : (
                <b>{structure.signature.toFixed(2)}</b>
              )}
            </div>
          ))}
      </div>
      <div className="upgrade-panel">
        <h3>Station Services</h3>
        {upgradeSystems.map((system) => {
          const cost = upgradeCostEstimate(myShip, system);
          return (
            <button
              type="button"
              key={system}
              data-testid={`upgrade-${system}`}
              data-busy={busyActions.has(`upgrade-${system}`)}
              aria-busy={busyActions.has(`upgrade-${system}`)}
              disabled={!canUse || credits < cost}
              onClick={() => onUpgrade(system)}
            >
              <span>
                <strong>{upgradeLabels[system]}</strong>
                <small>{upgradeEffect(system)}</small>
              </span>
              <b>{cost} cr</b>
            </button>
          );
        })}
      </div>
    </>
  );
}
