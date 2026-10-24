import { useState } from 'react';
import { Alert, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { postAdminAction } from '../../../services/adminActionService';

export default function StaffDeviceEnrolment({ driverId }) {
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const run = async (action) => {
    setBusy(true); setError(''); setApproval(null); setCopied(false);
    try {
      const result = await postAdminAction('staffDeviceEnrolment', { driverId, action }, {
        fallbackError: 'Device approval could not be updated.',
        reasonMessages: { RECENT_MFA_REQUIRED: 'Sign in again with multi-factor authentication, then retry within ten minutes.' },
      });
      setApproval(result);
    } catch (failure) { setError(failure.message || 'Device approval could not be updated.'); }
    finally { setBusy(false); }
  };
  return <Paper withBorder p="md">
    <Stack gap="sm">
      <Text fw={600}>Driver device approval</Text>
      <Text size="sm">Approve only a phone you trust. This approves the installation, not the person holding it. Driver access does not grant web-admin access.</Text>
      <Group>
        <Button loading={busy} onClick={() => run('issue')}>Create one-time code</Button>
        <Button disabled={busy} variant="light" onClick={() => run('replace')}>Replace all approved phones</Button>
        <Button disabled={busy} color="red" variant="light" onClick={() => run('revoke')}>Revoke all driver phones</Button>
      </Group>
      <Text size="xs" c="dimmed">Replace and revoke immediately remove this driver's access on all phones. A new code is required after driver logout.</Text>
      {error ? <Alert color="red">{error}</Alert> : null}
      {approval?.secret ? <>
        <Alert color="yellow">This secret is shown only here. Give it directly to the approved driver; never put it in chat or a manifest. It expires after ten minutes.</Alert>
        <TextInput readOnly value={approval.secret} label="One-time enrolment code" autoComplete="off" />
        <Group>
          <Button variant="light" onClick={async () => {
            try { await navigator.clipboard.writeText(approval.secret); setCopied(true); }
            catch { setError('Copy is unavailable. Select the code and copy it manually.'); }
          }}>{copied ? 'Copied' : 'Copy code'}</Button>
          <Button variant="subtle" onClick={() => setApproval(null)}>Hide code</Button>
        </Group>
      </> : approval?.revoked ? <Alert color="green">All approved driver phones have been revoked.</Alert> : null}
    </Stack>
  </Paper>;
}
