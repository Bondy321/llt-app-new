import { useState, useRef, useEffect } from 'react';
import { Alert, Button, Code, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { beginAdminTotpEnrollment, finishAdminTotpEnrollment, captureAdminIdentityCheck, signOutAdmin } from '../services/adminMfaService';
import { boundedRequest } from '../services/boundedRequest';

export default function AdminMfaSetup() {
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const begin = async () => {
    const attempt = ++generation.current;
    const sameIdentity = captureAdminIdentityCheck();
    const current = () => generation.current === attempt && sameIdentity();
    setBusy(true); setError('');
    try { const result = await boundedRequest(() => beginAdminTotpEnrollment(password)); if (current()) setEnrollment(result); }
    catch (failure) { if (current()) setError(failure.code === 'auth/operation-not-allowed' ? 'The account owner must enable TOTP multi-factor authentication in Firebase Authentication first.' : 'Unable to start authenticator setup. Check your password and verified email, then retry.'); }
    finally { if (current()) { setBusy(false); setPassword(''); } }
  };
  const finish = async () => {
    const attempt = ++generation.current;
    const sameIdentity = captureAdminIdentityCheck();
    const current = () => generation.current === attempt && sameIdentity();
    setBusy(true); setError('');
    try {
      await boundedRequest(() => finishAdminTotpEnrollment(enrollment, code));
      if (!current()) return;
      setEnrollment(null); setCode('');
      await signOutAdmin(); // New sign-in proves the second factor in server-issued claims.
    } catch { if (current()) setError('Setup was not confirmed. Sign out and sign in again to check whether the authenticator was enrolled before retrying.'); }
    finally { if (current()) setBusy(false); }
  };
  return <Paper maw={480} mx="auto" my="xl" p="xl" withBorder>
    <Stack>
      <Title order={2}>Secure your admin access</Title>
      <Text>Operations access requires an authenticator. Complete setup, then sign in again with your password and authenticator code.</Text>
      {error && <Alert color="red" role="alert">{error}</Alert>}
      {enrollment ? <>
        <Text>Add an account in your authenticator using this setup key. Keep it private; it is shown only during this setup.</Text>
        <Code block>{enrollment.secret.secretKey}</Code>
        <TextInput label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value)} />
        <Button loading={busy} onClick={finish}>Confirm authenticator and sign out</Button>
      </> : <>
        <PasswordInput label="Current password" value={password} onChange={event => setPassword(event.target.value)} />
        <Button loading={busy} onClick={begin}>Set up authenticator</Button>
      </>}
      <Button variant="subtle" onClick={() => { generation.current += 1; setEnrollment(null); setPassword(''); setCode(''); setBusy(false); void signOutAdmin(); }}>Cancel and sign out</Button>
    </Stack>
  </Paper>;
}
