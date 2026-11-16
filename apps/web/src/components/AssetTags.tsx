import { useState, type FormEvent } from 'react';
import { useAction } from '../hooks';
import type { Asset } from '../types';
import { ErrorNotice, Field, Panel } from './ui';

export function AssetTags({ asset, canEdit }: { asset: Asset; canEdit: boolean }) {
  const action = useAction();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const identifiers = (asset.identifiers ?? []).filter((identifier) => identifier.kind === 'QR');
  const add = async (event: FormEvent) => {
    event.preventDefault();
    await action.mutateAsync({
      path: `/assets/${asset.id}/identifiers`,
      body: { kind: 'QR', value: value.trim(), reason: reason.trim() },
    });
    setValue('');
    setReason('');
    setOpen(false);
  };
  return (
    <Panel
      title="Tags"
      action={
        canEdit ? (
          <button type="button" className="button secondary small" onClick={() => setOpen(!open)}>
          {open ? 'Cancel' : 'Add QR code'}
          </button>
        ) : undefined
      }
    >
      <ErrorNotice error={action.error} />
      {identifiers.length ? (
        <div className="row-list">
          {identifiers.map((identifier) => (
            <div className="row-list-item" key={identifier.id}>
              <div>
                <strong>{identifier.kind}</strong>
                <span className="mono"> {identifier.value}</span>
              </div>
              {canEdit ? (
                <button
                  type="button"
                  className="button text small"
                  onClick={() => {
                    const why = window.prompt('Reason for removing this tag');
                    if (why?.trim())
                      void action.mutateAsync({
                        path: `/assets/${asset.id}/identifiers/${identifier.id}`,
                        method: 'DELETE',
                        body: { reason: why.trim() },
                      });
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No QR code has been added.</p>
      )}
      {open ? (
        <form className="form-grid subsection" onSubmit={add}>
          <Field label="Value" htmlFor={`tag-value-${asset.id}`}>
            <input id={`tag-value-${asset.id}`} value={value} onChange={(event) => setValue(event.target.value)} required maxLength={200} />
          </Field>
          <Field label="Reason" htmlFor={`tag-reason-${asset.id}`}>
            <input id={`tag-reason-${asset.id}`} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} />
          </Field>
          <button className="button small" disabled={action.isPending || !value.trim() || !reason.trim()}>
            Save QR code
          </button>
        </form>
      ) : null}
    </Panel>
  );
}
