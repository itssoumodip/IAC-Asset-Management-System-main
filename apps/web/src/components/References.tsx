import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { References, LocationReference } from '../types';
import { Badge, Select } from './ui';

export function useReferences() {
  return useQuery({
    queryKey: ['references'],
    queryFn: ({ signal }) => api<References>('/references', { signal }),
    staleTime: 120_000,
  });
}
const aliases: Record<string, string> = { ownershipType: 'OWNERSHIP', riskLevel: 'RISK' };
const normalize = (value: string) => value.toLowerCase().replaceAll(/[^a-z]/g, '');
function kindMatches(left: string, right: string) {
  return normalize(left) === normalize(aliases[right] ?? right);
}
export function referenceOptions(
  refs: References | undefined,
  kind: string,
  includeInactive = false,
) {
  return (
    refs?.values.filter(
      (value) => (includeInactive || value.active) && kindMatches(value.kind, kind),
    ) ?? []
  );
}
export function referenceLabel(
  refs: References | undefined,
  kind: string,
  code: string | null | undefined,
) {
  if (!code) return 'Unknown';
  return (
    refs?.values.find((value) => value.code === code && kindMatches(value.kind, kind))?.label ??
    code
  );
}
export function locationLabel(item: LocationReference) {
  return (
    item.path ||
    item.name ||
    [item.site, item.building, item.floor, item.room].filter(Boolean).join(' / ') ||
    item.code
  );
}
export function ReferenceBadge({
  refs,
  kind,
  value,
}: {
  refs?: References;
  kind: string;
  value?: string | null;
}) {
  return <Badge value={value} label={referenceLabel(refs, kind, value)} />;
}
export function ReferenceSelect({
  refs,
  kind,
  id,
  value,
  onChange,
  required = true,
  allowEmpty = false,
  includeInactive = false,
  preserveCurrent = true,
}: {
  refs?: References;
  kind: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  allowEmpty?: boolean;
  includeInactive?: boolean;
  preserveCurrent?: boolean;
}) {
  const values = referenceOptions(refs, kind, includeInactive);
  const current = refs?.values.find((item) => item.code === value && kindMatches(item.kind, kind));
  const unavailable = value && !values.some((item) => item.code === value);

  const options = [
    { value: '', label: allowEmpty ? 'All' : required ? 'Select...' : 'Not set' },
    ...(unavailable && preserveCurrent && current
      ? [{ value: current.code, label: `${current.label}${current.active === false ? ' (inactive)' : ''}`, disabled: !preserveCurrent }]
      : []),
    ...values.map((item) => ({
      value: item.code,
      label: `${item.label}${item.active === false ? ' (inactive)' : ''}`,
      disabled: item.active === false,
    })),
  ];

  return (
    <Select
      label=""
      htmlFor={id}
      value={value}
      onChange={onChange}
      options={options}
      required={required}
      disabled={false}
    />
  );
}
