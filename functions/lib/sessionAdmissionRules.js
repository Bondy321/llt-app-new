'use strict';

// Login has an exact server-owned admission in the same coordination node that
// blocks established clients during assignment. Only that prepared operation
// may finish; a generic marker, another admission or a transition is not proof.
const sessionAdmissionRules = () => {
  const staff = "root.child('app_session_authority').child(auth.uid).child('staff')";
  const driverId = "newData.child('app_sessions').child(auth.uid).child('driverId').val()";
  const assignment = `root.child('driver_assignment_active/v1').child(${driverId})`;
  const ownAssignment = `${assignment}.child('loginAdmissions').child(${staff}.child('assignmentAdmissionId').val())`;
  const policy = "root.child('driver_login_policy/v1')";
  const ownPolicy = `${policy}.child('loginAdmissions').child(${staff}.child('policyAdmissionId').val())`;
  const assignmentGate = `(${staff}.child('assignmentAdmissionId').exists() ? (${staff}.child('assignmentAdmissionId').isString() && ${assignment}.child('schemaVersion').val() === 1 && ${assignment}.hasChildren(['schemaVersion', 'loginAdmissions']) && !${assignment}.child('transitionId').exists() && ${ownAssignment}.child('authUidHash').val() === ${staff}.child('admissionAuthUidHash').val() && ${ownAssignment}.child('expiresAtMs').val() > now) : !${assignment}.exists())`;
  const stable = `(!${policy}.child('transitionPhase').exists() || ${policy}.child('transitionPhase').val() === 'stable')`;
  const policyGate = `(${staff}.child('policyAdmissionId').exists() ? (${staff}.child('policyAdmissionId').isString() && ${ownPolicy}.child('schemaVersion').val() === 1 && ${ownPolicy}.child('admissionType').val() === 'driver_login' && ${ownPolicy}.child('authUidHash').val() === ${staff}.child('admissionAuthUidHash').val() && ${ownPolicy}.child('generation').val() === newData.child('app_sessions').child(auth.uid).child('driverLoginPolicyGeneration').val() && ${ownPolicy}.child('policyRevision').val() === ${staff}.child('admissionPolicyRevision').val() && ${ownPolicy}.child('expiresAtMs').val() > now && ((${stable} && ${policy}.child('revision').val() === ${staff}.child('admissionPolicyRevision').val()) || (${policy}.child('transitionPhase').val() === 'draining' && ${policy}.child('revision').val() === ${staff}.child('admissionPolicyRevision').val() + 1))) : ${stable})`;
  return { assignmentGate, policyGate };
};

module.exports = { sessionAdmissionRules };
