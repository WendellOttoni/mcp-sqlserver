import { loadCatalog } from "./catalog-loader.js";

export class CatalogCache {
  constructor(dbContext, ttlMs) {
    this.dbContext = dbContext;
    this.ttlMs = ttlMs;
    this.catalog = null;
    this.lastLoadedAt = null;
    this.loadingPromise = null;
    this.metrics = {
      hits: 0,
      staleHits: 0,
      misses: 0,
      refreshes: 0,
    };
  }

  isFresh() {
    if (!this.catalog || !this.lastLoadedAt) {
      return false;
    }

    return Date.now() - this.lastLoadedAt.getTime() < this.ttlMs;
  }

  async getCatalog({ force = false } = {}) {
    if (!force && this.isFresh()) {
      this.metrics.hits += 1;
      return this.catalog;
    }

    if (!force && this.catalog) {
      this.metrics.staleHits += 1;
      if (!this.loadingPromise) {
        this.loadingPromise = loadCatalog(this.dbContext)
          .then((catalog) => {
            this.catalog = catalog;
            this.lastLoadedAt = new Date();
            this.metrics.refreshes += 1;
            return catalog;
          })
          .finally(() => {
            this.loadingPromise = null;
          });
      }
      return this.catalog;
    }

    this.metrics.misses += 1;
    if (!this.loadingPromise) {
      this.loadingPromise = loadCatalog(this.dbContext)
        .then((catalog) => {
          this.catalog = catalog;
          this.lastLoadedAt = new Date();
          this.metrics.refreshes += 1;
          return catalog;
        })
        .finally(() => {
          this.loadingPromise = null;
        });
    }

    return this.loadingPromise;
  }

  async refresh() {
    return this.getCatalog({ force: true });
  }

  getStatus() {
    return {
      loaded: Boolean(this.catalog),
      lastLoadedAt: this.lastLoadedAt,
      ttlMs: this.ttlMs,
      metrics: { ...this.metrics },
    };
  }
}
