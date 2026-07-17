/**
 * Minimal in-memory MapLibre-compatible host for scheduled SDK workflow
 * evidence. It records only the source and layer mutations needed to prove
 * that the published data-to-map bridge completed; it does not render UI.
 */
export class EvidenceMap {
  constructor() {
    this.sources = new Map();
    this.layers = new Map();
  }

  getSource(id) {
    return this.sources.get(id);
  }

  addSource(id, specification) {
    const source = {
      ...specification,
      setData(data) {
        source.data = data;
      },
    };
    this.sources.set(id, source);
  }

  removeSource(id) {
    this.sources.delete(id);
  }

  getLayer(id) {
    return this.layers.get(id);
  }

  addLayer(layer) {
    this.layers.set(String(layer.id), layer);
  }

  removeLayer(id) {
    this.layers.delete(id);
  }
}
