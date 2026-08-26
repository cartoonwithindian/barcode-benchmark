import { EngineLifecycleStatus } from './barcode.model';

export interface CommercialSdkSlot {
  name: string;
  packageHint: string;
  license: 'Commercial';
  status: Extract<EngineLifecycleStatus, 'license_required'>;
  reason: string;
}

/**
 * Placeholders for commercial SDKs. Per project rules these are NEVER faked:
 * they appear in the UI as "Requires SDK/license configuration" and are kept
 * isolated from the working engine list.
 */
export const COMMERCIAL_SLOTS: CommercialSdkSlot[] = [
  {
    name: 'Dynamsoft Barcode Reader',
    packageHint: 'dynamsoft-barcode-reader-bundle',
    license: 'Commercial',
    status: 'license_required',
    reason: 'Requires SDK/license configuration (product key).',
  },
  {
    name: 'Scandit',
    packageHint: 'scandit-web-datacapture-barcode',
    license: 'Commercial',
    status: 'license_required',
    reason: 'Requires SDK/license configuration (license key bound to domain).',
  },
  {
    name: 'Anyline',
    packageHint: '@anyline/*',
    license: 'Commercial',
    status: 'license_required',
    reason: 'Requires SDK/license configuration.',
  },
  {
    name: 'STRICH',
    packageHint: '@strich/sdk',
    license: 'Commercial',
    status: 'license_required',
    reason: 'Requires SDK/license configuration (paid domain-locked key).',
  },
  {
    name: 'Microblink',
    packageHint: '@microblink/*',
    license: 'Commercial',
    status: 'license_required',
    reason: 'Requires SDK/license configuration (BlinkID products).',
  },
];
