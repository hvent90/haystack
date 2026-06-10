import type { ReactNode } from "react";
import { useState } from "react";
import { Copy, RotateCcw, Save, Trash2 } from "lucide-react";
import type { FroxelTuning } from "../../gpu/kernels/froxels";
import { FROXEL_DEFAULTS, applyFroxelTuning } from "../../gpu/kernels/froxels";

const STORAGE_KEY = "haystack.fogSettings";
const PRESETS_KEY = "haystack.fogPresets";

const BUILT_IN_PRESETS: Record<string, FroxelTuning> = {
  "ED 20 km": {
    sigmaScale: 0.17,
    sigmaFloor: 0.01,
    albedo: { r: 0.66, g: 0.58, b: 0.47 },
    ambient: 0.03,
    sunStrength: 1.5,
    hgG: 0.3,
    flashStrength: 1,
    mix: 1,
    fadeStart: 17,
  },
  Claustrophobic: {
    sigmaScale: 1.75,
    sigmaFloor: 0.01,
    albedo: { r: 0.66, g: 0.58, b: 0.47 },
    ambient: 0.012,
    sunStrength: 1.0,
    hgG: 0.45,
    flashStrength: 1,
    mix: 1,
    fadeStart: 8,
  },
};

export function FogSettingsWindow(): ReactNode {
  const [tuning, setTuning] = useState<Partial<FroxelTuning>>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  });
  const [presets, setPresets] = useState<Record<string, FroxelTuning>>(() => {
    const stored = localStorage.getItem(PRESETS_KEY);
    return stored ? JSON.parse(stored) : {};
  });
  const [presetName, setPresetName] = useState("");
  const [showPresetInput, setShowPresetInput] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

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

  const savePreset = () => {
    if (presetName.trim()) {
      const effective: FroxelTuning = { ...FROXEL_DEFAULTS, ...tuning };
      const newPresets = { ...presets, [presetName]: effective };
      setPresets(newPresets);
      localStorage.setItem(PRESETS_KEY, JSON.stringify(newPresets));
      setPresetName("");
      setShowPresetInput(false);
    }
  };

  const loadPreset = (name: string) => {
    const preset = BUILT_IN_PRESETS[name] || presets[name];
    if (preset) {
      const partial = Object.fromEntries(
        Object.entries(preset).filter(
          ([k]) => preset[k as keyof FroxelTuning] !== FROXEL_DEFAULTS[k as keyof FroxelTuning],
        ),
      ) as Partial<FroxelTuning>;
      setTuning(partial);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(partial));
      applyFroxelTuning(partial);
    }
  };

  const deletePreset = (name: string) => {
    const newPresets = { ...presets };
    delete newPresets[name];
    setPresets(newPresets);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(newPresets));
  };

  const effective: FroxelTuning = { ...FROXEL_DEFAULTS, ...tuning };
  const isModified = Object.keys(tuning).length > 0;
  const visibilityKm = tuning.sigmaScale
    ? (3 / (0.9 * tuning.sigmaScale)).toFixed(1)
    : (3 / (0.9 * FROXEL_DEFAULTS.sigmaScale)).toFixed(1);

  const fieldProps = {
    stopPropagation: (e: React.KeyboardEvent) => e.stopPropagation(),
  };

  return (
    <div className="fog-settings-window" onKeyDown={handleKeyDown}>
      {isModified && <div className="fog-modified-indicator">Modified from defaults</div>}

      <div className="fog-preset-section">
        <h3>Presets</h3>
        <div className="fog-preset-buttons">
          {Object.keys(BUILT_IN_PRESETS).map((name) => (
            <button
              key={name}
              type="button"
              className="preset-btn"
              onClick={() => loadPreset(name)}
            >
              {name}
            </button>
          ))}
          {Object.keys(presets).map((name) => (
            <div key={name} className="preset-saved">
              <button type="button" className="preset-btn saved" onClick={() => loadPreset(name)}>
                {name}
              </button>
              <button
                type="button"
                className="preset-delete"
                onClick={() => deletePreset(name)}
                title="Delete preset"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="fog-save-preset">
          {showPresetInput ? (
            <>
              <input
                type="text"
                placeholder="Preset name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") savePreset();
                  if (e.key === "Escape") {
                    setShowPresetInput(false);
                    setPresetName("");
                  }
                }}
                autoFocus
              />
              <button type="button" onClick={savePreset}>
                Save
              </button>
              <button type="button" onClick={() => setShowPresetInput(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="save-preset-btn"
              onClick={() => setShowPresetInput(true)}
            >
              <Save size={14} />
              Save as Preset
            </button>
          )}
        </div>
      </div>

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
              onKeyDown={fieldProps.stopPropagation}
              title="0 = fog off, 1 = fully applied"
            />
            <input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={effective.mix.toFixed(2)}
              onChange={(e) => updateTuning({ mix: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>
      </div>

      <div className="fog-section">
        <h3>Medium</h3>
        <div className="fog-control">
          <label title="Extinction per unit baked density — rocks dissolve at visibility distance">
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
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0.01"
              max="4"
              step="0.01"
              value={effective.sigmaScale.toFixed(3)}
              onChange={(e) => updateTuning({ sigmaScale: parseFloat(e.target.value) || 0.01 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
          <div className="fog-readout">Visibility ≈ {visibilityKm} km</div>
        </div>

        <div className="fog-control">
          <label title="Uniform dust floor outside the belt">
            Sigma Floor (0–0.1)
            <input
              type="range"
              min="0"
              max="0.1"
              step="0.001"
              value={effective.sigmaFloor}
              onChange={(e) => updateTuning({ sigmaFloor: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="0.1"
              step="0.001"
              value={effective.sigmaFloor.toFixed(4)}
              onChange={(e) => updateTuning({ sigmaFloor: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>
      </div>

      <div className="fog-section">
        <h3>Glow</h3>
        <div className="fog-control">
          <label title="Isotropic ambient brightness">
            Ambient (0–0.2)
            <input
              type="range"
              min="0"
              max="0.2"
              step="0.001"
              value={effective.ambient}
              onChange={(e) => updateTuning({ ambient: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="0.2"
              step="0.001"
              value={effective.ambient.toFixed(3)}
              onChange={(e) => updateTuning({ ambient: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>

        <div className="fog-control">
          <label title="Sun in-scatter gain (carries god rays and shadows)">
            Sun Strength (0–3)
            <input
              type="range"
              min="0"
              max="3"
              step="0.01"
              value={effective.sunStrength}
              onChange={(e) => updateTuning({ sunStrength: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="3"
              step="0.01"
              value={effective.sunStrength.toFixed(2)}
              onChange={(e) => updateTuning({ sunStrength: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>

        <div className="fog-control">
          <label title="Forward/backward scatter anisotropy (0=uniform, 1=bright toward sun)">
            HG Anisotropy (0–0.9)
            <input
              type="range"
              min="0"
              max="0.9"
              step="0.01"
              value={effective.hgG}
              onChange={(e) => updateTuning({ hgG: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="0.9"
              step="0.01"
              value={effective.hgG.toFixed(2)}
              onChange={(e) => updateTuning({ hgG: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>

        <div className="fog-control">
          <label title="Dust color tint (warm = rocky, cool = icy)">Albedo Color</label>
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
                onKeyDown={fieldProps.stopPropagation}
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
                onKeyDown={fieldProps.stopPropagation}
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
                onKeyDown={fieldProps.stopPropagation}
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
                onKeyDown={fieldProps.stopPropagation}
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
                onKeyDown={fieldProps.stopPropagation}
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
                onKeyDown={fieldProps.stopPropagation}
              />
            </div>
          </div>
          <div
            className="fog-color-swatch"
            style={{
              backgroundColor: `rgb(${Math.round(effective.albedo.r * 255)}, ${Math.round(
                effective.albedo.g * 255,
              )}, ${Math.round(effective.albedo.b * 255)})`,
            }}
          />
        </div>
      </div>

      <div className="fog-section">
        <h3>Falloff</h3>
        <div className="fog-control">
          <label title="Distance where fog begins to fade to transparent">
            Fade Start (0–24 km)
            <input
              type="range"
              min="0"
              max="24"
              step="0.1"
              value={effective.fadeStart}
              onChange={(e) => updateTuning({ fadeStart: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="24"
              step="0.1"
              value={effective.fadeStart.toFixed(1)}
              onChange={(e) => updateTuning({ fadeStart: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
          <div className="fog-readout">Fog ends at {effective.fadeStart.toFixed(1)} km</div>
        </div>
      </div>

      <div className="fog-section">
        <h3>Other</h3>
        <div className="fog-control">
          <label title="Volumetric flashlight beam strength (press F in-game)">
            Flash Strength (0–4)
            <input
              type="range"
              min="0"
              max="4"
              step="0.01"
              value={effective.flashStrength}
              onChange={(e) => updateTuning({ flashStrength: parseFloat(e.target.value) })}
              onKeyDown={fieldProps.stopPropagation}
            />
            <input
              type="number"
              min="0"
              max="4"
              step="0.01"
              value={effective.flashStrength.toFixed(2)}
              onChange={(e) => updateTuning({ flashStrength: parseFloat(e.target.value) || 0 })}
              onKeyDown={fieldProps.stopPropagation}
            />
          </label>
        </div>
      </div>

      <div className="fog-actions">
        <button type="button" onClick={reset} title="Reset all to defaults">
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
