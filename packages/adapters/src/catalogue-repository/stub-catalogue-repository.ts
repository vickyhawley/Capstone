import {
  type CatalogueRepository,
  NotImplementedError,
  type Product,
  type ProductVariant,
  type StockLevel,
} from '@groundwork/core';

export class StubCatalogueRepository implements CatalogueRepository {
  async getProduct(_id: string): Promise<Product | null> {
    throw new NotImplementedError('CatalogueRepository', 'Sprint 1');
  }

  async listVariants(_productId: string): Promise<readonly ProductVariant[]> {
    throw new NotImplementedError('CatalogueRepository', 'Sprint 1');
  }

  async getStock(_variantId: string): Promise<StockLevel | null> {
    throw new NotImplementedError('CatalogueRepository', 'Sprint 1');
  }
}
