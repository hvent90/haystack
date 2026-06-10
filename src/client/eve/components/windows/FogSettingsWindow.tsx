import type { ReactNode } from "react";
import { useState } from "react";
import { Copy, RotateCcw } from "lucide-react";
import type { FroxelTuning } from "../../gpu/kernels/froxels";
import { FROXEL_DEFAULTS, applyFroxelTuning } from "../../gpu/kernels/froxels";

const STORAGE_KEY = "haystack.fogSettings";

export function FogSettingsWindow(): ReactNode {
  const [tuning, setTuning] = useState<Partial<FroxelTuning>>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  });

  // Keyboard input shouldn't leak into flight controls
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  // Helper to update tuning and apply to render
  const updateTuning = (patch: Partial<FroxelTuning>) => {
    const next = { ...tuning, ...patch };
    setTuning(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    applyFroxelTuning(next);
  };

  const reset = () => {
    setTuning({});
    localStorage.removeItem(STORAGE_KEY);
    applyFroxelTuning(null);
  };

  const copyJSON = () => {
    const effective: FroxelTuning = { ...FROXEL_DEFAULTS, ...tuning };
    const json = JSON.stringify(effective, null, 2);
    navigator.clipboard.writeText(json);
  };

  // Get effective values (defaults merged with overrides)
  const effective: FroxelTuning = { ...FROXEL_DEFAULTS, ...tuning };

  // Calculate visibility km from sigmaScale
  const visibilityKm = tuning.sigmaScale
    ? (3 / (0.9 * tuning.sigmaScale)).toFixed(1)
    : (3 / (0.9 * FROXEL_DEFAULTS.sigmaScale)).toFixed(1);

  return (
    <div className="fog-settings-window" onKeyDown={handleKeyDown}>
      <div className="fog-section">
        <div className="fog-control">
          <label>
            Mix (Master Fader)
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={effective.mix}
              onChange={(e) => updateTuning({ mix: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={effective.mix.toFixed(2)}
              onChange={(e) => updateTuning({ mix: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>
      </div>

      <div className="fog-section">
        <h3>Medium</h3>
        <div className="fog-control">
          <label>
            Sigma Scale (log 0.01–4.0)
            <input
              type="range"
              min="-2"
              max="1.386"
              step="0.05"
              value={Math.log10(effective.sigmaScale)}
              onChange={(e) =>
                updateTuning({ sigmaScale: Math.pow(10, parseFloat(e.target.value)) })
              }
            />
            <input
              type="number"
              min="0.01"
              max="4"
              step="0.01"
              value={effective.sigmaScale.toFixed(3)}
              onChange={(e) => updateTuning({ sigmaScale: parseFloat(e.target.value) || 0.01 })}
            />
          </label>
          <div className="fog-readout">Visibility ≈ {visibilityKm} km</div>
        </div>

        <div className="fog-control">
          <label>
            Sigma Floor (0–0.1)
            <input
              type="range"
              min="0"
              max="0.1"
              step="0.001"
              value={effective.sigmaFloor}
              onChange={(e) => updateTuning({ sigmaFloor: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="0.1"
              step="0.001"
              value={effective.sigmaFloor.toFixed(4)}
              onChange={(e) => updateTuning({ sigmaFloor: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>
      </div>

      <div className="fog-section">
        <h3>Glow</h3>
        <div className="fog-control">
          <label>
            Ambient (0–0.2)
            <input
              type="range"
              min="0"
              max="0.2"
              step="0.001"
              value={effective.ambient}
              onChange={(e) => updateTuning({ ambient: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="0.2"
              step="0.001"
              value={effective.ambient.toFixed(3)}
              onChange={(e) => updateTuning({ ambient: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>

        <div className="fog-control">
          <label>
            Sun Strength (0–3)
            <input
              type="range"
              min="0"
              max="3"
              step="0.01"
              value={effective.sunStrength}
              onChange={(e) => updateTuning({ sunStrength: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="3"
              step="0.01"
              value={effective.sunStrength.toFixed(2)}
              onChange={(e) => updateTuning({ sunStrength: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>

        <div className="fog-control">
          <label>
            HG Anisotropy (0–0.9)
            <input
              type="range"
              min="0"
              max="0.9"
              step="0.01"
              value={effective.hgG}
              onChange={(e) => updateTuning({ hgG: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="0.9"
              step="0.01"
              value={effective.hgG.toFixed(2)}
              onChange={(e) => updateTuning({ hgG: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>

        <div className="fog-control">
          <label>Albedo Color</label>
          <div className="fog-color-inputs">
            <div>
              <label>R</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.r}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, r: parseFloat(e.target.value) },
                  })
                }
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.r.toFixed(2)}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, r: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </div>
            <div>
              <label>G</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.g}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, g: parseFloat(e.target.value) },
                  })
                }
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.g.toFixed(2)}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, g: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </div>
            <div>
              <label>B</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.b}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, b: parseFloat(e.target.value) },
                  })
                }
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={effective.albedo.b.toFixed(2)}
                onChange={(e) =>
                  updateTuning({
                    albedo: { ...effective.albedo, b: parseFloat(e.target.value) || 0 },
                  })
                }
              />
            </div>
          </div>
          <div
            className="fog-color-swatch"
            style={{
              backgroundColor: `rgb(${Math.round(effective.albedo.r * 255)}, ${Math.round(effective.albedo.g * 255)}, ${Math.round(effective.albedo.b * 255)})`,
            }}
          />
        </div>
      </div>

      <div className="fog-section">
        <h3>Other</h3>
        <div className="fog-control">
          <label>
            Flash Strength (0–4)
            <input
              type="range"
              min="0"
              max="4"
              step="0.01"
              value={effective.flashStrength}
              onChange={(e) => updateTuning({ flashStrength: parseFloat(e.target.value) })}
            />
            <input
              type="number"
              min="0"
              max="4"
              step="0.01"
              value={effective.flashStrength.toFixed(2)}
              onChange={(e) => updateTuning({ flashStrength: parseFloat(e.target.value) || 0 })}
            />
          </label>
        </div>
      </div>

      <div className="fog-actions">
        <button type="button" onClick={reset} title="Reset to defaults">
          <RotateCcw size={14} />
          Reset
        </button>
        <button type="button" onClick={copyJSON} title="Copy tuning object to clipboard">
          <Copy size={14} />
          Copy JSON
        </button>
      </div>
    </div>
  );
}
