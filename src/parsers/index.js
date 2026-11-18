import { suppliers, supplierByKey, detectSupplier } from './suppliers.js';

export const registry = {
  all: suppliers,
  get: supplierByKey,
  detect: detectSupplier,
};

export default registry;
