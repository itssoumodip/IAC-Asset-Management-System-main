import { useState, type FormEvent } from 'react';
import { useAction } from '../hooks';
import type { Asset, References } from '../types';
import { ErrorNotice, Field, Select } from './ui';
import { locationLabel } from './References';

export function StoreReceiving({
  asset,
  refs,
}: {
  asset: Asset;
  refs?: References;
}) {
  const action = useAction();
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const options = (refs?.locations ?? [])
    .filter((location) => location.active && ['STORE', 'RACK'].includes(location.level ?? ''))
    .map((location) => ({ value: location.id, label: locationLabel(location) }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await action.mutateAsync({
      path: `/assets/${asset.id}/receive`,
      body: { locationId, note: note.trim() },
    });
    setNote('');
  };
  return (
    <form className="form-grid subsection" onSubmit={submit}>
      <ErrorNotice error={action.error} />
      <Select
        label="Store or rack"
        htmlFor={`receive-location-${asset.id}`}
        value={locationId}
        onChange={setLocationId}
        required
        options={[{ value: '', label: 'Choose a store or rack' }, ...options]}
      />
      <Field label="Receiving note" htmlFor={`receive-note-${asset.id}`}>
        <input
          id={`receive-note-${asset.id}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          required
          maxLength={5000}
        />
      </Field>
      <button className="button small" disabled={action.isPending || !locationId || !note.trim()}>
        Receive into store
      </button>
    </form>
  );
}
