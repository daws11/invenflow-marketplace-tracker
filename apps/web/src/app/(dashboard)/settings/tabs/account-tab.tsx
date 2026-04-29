'use client';

// Account tab — change password (PRD §7.8 tab 6). Posts to
// /api/account/change-password which validates the current password with
// bcrypt.compare and re-hashes the new one with cost 12.

import { type FormEvent, useState } from 'react';

import {
  Banner,
  Field,
  buttonPrimaryClass,
  inputClass,
} from '../_form-helpers';

export function AccountTab() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<
    { kind: 'success' | 'error'; msg: string } | null
  >(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBanner(null);

    if (newPassword !== confirmPassword) {
      setBanner({ kind: 'error', msg: 'New password and confirmation do not match.' });
      return;
    }
    if (newPassword.length < 8) {
      setBanner({ kind: 'error', msg: 'New password must be at least 8 characters.' });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to change password');
      }
      setBanner({ kind: 'success', msg: 'Password changed.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setBanner({ kind: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="currentPassword" label="Current password">
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field id="newPassword" label="New password" hint="Minimum 8 characters.">
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field id="confirmPassword" label="Confirm new password">
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={inputClass}
        />
      </Field>

      {banner ? <Banner kind={banner.kind}>{banner.msg}</Banner> : null}

      <div>
        <button
          type="submit"
          disabled={submitting}
          className={buttonPrimaryClass}
        >
          {submitting ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}
