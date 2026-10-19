/**
 * RecipeBuilder: Validates assembly plans and derives the 4 model recipes
 * (baseline, a, b, ab) for stitch-cpu-v1.
 * Follows CONTRACTS.md §5 & P3-SPEC.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  type AssemblyPlan,
  type ModuleCard,
  EvolverError,
  assertNoUnknownProperties,
  validateNonEmptyString,
} from '../contracts/index.ts';

export interface ValidationReport {
  valid: boolean;
  errors: string[];
}

export interface RecipeModuleSpec {
  id: string;
  implementationId: string;
  implementationPath: string;
  className: string;
}

export interface ModelRecipe {
  schemaVersion: number;
  planId: string;
  variant: 'baseline' | 'a' | 'b' | 'ab';
  slotId: string;
  modules: RecipeModuleSpec[];
  recipeHash: string;
}

export class RecipeBuilder {
  validate(plan: AssemblyPlan, catalog: readonly ModuleCard[]): ValidationReport {
    const errors: string[] = [];

    if (!plan || typeof plan !== 'object') {
      return { valid: false, errors: ['Plan must be an object'] };
    }

    try {
      validateNonEmptyString(plan.id, 'plan.id');
    } catch (e: any) {
      errors.push(e.message);
    }

    if (!plan.bindings || !Array.isArray(plan.bindings)) {
      errors.push('plan.bindings must be an array');
      return { valid: false, errors };
    }

    const prePoolBinding = plan.bindings.find((b) => b.slotId === 'features.pre_pool');
    if (!prePoolBinding) {
      errors.push('Missing required binding for slot "features.pre_pool"');
    }

    for (const b of plan.bindings) {
      if (b.slotId !== 'features.pre_pool') {
        errors.push(`Unknown binding slot: "${b.slotId}". Only "features.pre_pool" is allowed in stitch-cpu-v1.`);
      }

      if (!Array.isArray(b.orderedModuleRefs)) {
        errors.push(`Binding for slot "${b.slotId}" must have array orderedModuleRefs`);
        continue;
      }

      const seen = new Set<string>();
      for (const mref of b.orderedModuleRefs) {
        if (seen.has(mref)) {
          errors.push(`Duplicate module reference "${mref}" in slot "${b.slotId}"`);
        }
        seen.add(mref);

        const found = catalog.find((c) => c.id === mref);
        if (!found) {
          errors.push(`Referenced module "${mref}" not found in ready catalog`);
        }
      }

      // Check ordering rule: ASPP must precede SE
      const hasAspp = b.orderedModuleRefs.includes('module-aspp-v1');
      const hasSe = b.orderedModuleRefs.includes('module-se-v1');
      if (hasAspp && hasSe) {
        const asppIdx = b.orderedModuleRefs.indexOf('module-aspp-v1');
        const seIdx = b.orderedModuleRefs.indexOf('module-se-v1');
        if (asppIdx > seIdx) {
          errors.push('Module order violation: ASPP must precede SE in features.pre_pool (EVAL.md §1)');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  build(plan: AssemblyPlan, variant: 'baseline' | 'a' | 'b' | 'ab'): ModelRecipe {
    const asppSpec: RecipeModuleSpec = {
      id: 'module-aspp-v1',
      implementationId: 'impl-aspp-8ch-v1',
      implementationPath: path.resolve('fixtures/modules/aspp_block.py').replace(/\\/g, '/'),
      className: 'ASPPBlock',
    };

    const seSpec: RecipeModuleSpec = {
      id: 'module-se-v1',
      implementationId: 'impl-se-8ch-v1',
      implementationPath: path.resolve('fixtures/modules/se_block.py').replace(/\\/g, '/'),
      className: 'SEBlock',
    };

    let selectedModules: RecipeModuleSpec[] = [];
    switch (variant) {
      case 'baseline':
        selectedModules = [];
        break;
      case 'a':
        selectedModules = [asppSpec];
        break;
      case 'b':
        selectedModules = [seSpec];
        break;
      case 'ab':
        selectedModules = [asppSpec, seSpec];
        break;
      default:
        throw new EvolverError('INVALID_INPUT', `Unknown variant: ${variant}`);
    }

    const recipeCore = {
      schemaVersion: 1,
      planId: plan.id,
      variant,
      slotId: 'features.pre_pool',
      modules: selectedModules,
    };

    const recipeHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(recipeCore))
      .digest('hex');

    return {
      ...recipeCore,
      recipeHash,
    };
  }
}
