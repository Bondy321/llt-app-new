import {
  ActivityIndicator,
  Animated,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { FONT_SCALE_LIMITS } from '../../../../utils/responsiveLayout';
import { getReferencePlaceholder, LOGIN_MODE_HINTS } from '../../../../screens/loginFlow';
import { COLORS } from './loginPresentationTheme';
import styles from './loginScreenStyles';

export function LoginCredentialFields({
  activeInput, bookingReference, clearErrorState, email, emailVisible, errorState,
  handleEmailBlur, handleLogin, handleReferenceChange, height, loading, modeHintFocus,
  responsiveStyles, scrollRef, setActiveInput, setEmail, setFieldTouched, setModeHintFocus,
}) {
  return <>
              <View style={[styles.hintsRow, responsiveStyles.hintsRow]}>
                {Object.entries(LOGIN_MODE_HINTS).map(([key, hint]) => {
                  const selected = modeHintFocus === key;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={[styles.hintChip, responsiveStyles.hintChip, selected && styles.hintChipSelected]}
                      onPress={() => setModeHintFocus(key)}
                      accessibilityRole="button"
                      accessibilityLabel={`Select ${hint.label} login hint`}
                    >
                      <View style={styles.hintTitleRow}>
                        <MaterialCommunityIcons
                          name={key === 'driver' ? 'steering' : 'account-group'}
                          size={14}
                          color={selected ? COLORS.primaryBlue : COLORS.subtleText}
                        />
                        <Text
                          style={[styles.hintChipLabel, selected && styles.hintChipLabelSelected]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                        >
                          {hint.label}
                        </Text>
                      </View>
                      <Text
                        style={[styles.hintChipText, selected && styles.hintChipTextSelected]}
                        maxFontSizeMultiplier={FONT_SCALE_LIMITS.caption}
                      >
                        {hint.hint}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={[styles.inputContainer, activeInput === 'reference' && styles.inputContainerFocused]}>
                <MaterialCommunityIcons name="ticket-confirmation-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, responsiveStyles.input]}
                  value={bookingReference}
                  onChangeText={handleReferenceChange}
                  onFocus={() => {
                    setActiveInput('reference');
                    scrollRef.current?.scrollTo({ y: height * 0.24, animated: true });
                  }}
                  onBlur={() => {
                    setActiveInput(null);
                    setFieldTouched((current) => ({ ...current, bookingReference: true }));
                  }}
                  placeholder={getReferencePlaceholder(modeHintFocus)}
                  placeholderTextColor={COLORS.placeholderText}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={20}
                  returnKeyType="go"
                  onSubmitEditing={handleLogin}
                  editable={!loading}
                  accessibilityLabel="Booking reference or driver code"
                  maxFontSizeMultiplier={FONT_SCALE_LIMITS.form}
                />
              </View>

              {emailVisible ? (
                <View style={[styles.inputContainer, activeInput === 'email' && styles.inputContainerFocused]}>
                  <MaterialCommunityIcons name="email-outline" size={22} color={COLORS.primaryBlue} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, responsiveStyles.input]}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text);
                      if (errorState && !errorState.reason) clearErrorState();
                    }}
                    onFocus={() => {
                      setActiveInput('email');
                      scrollRef.current?.scrollTo({ y: height * 0.32, animated: true });
                    }}
                    onBlur={() => {
                      setActiveInput(null);
                      handleEmailBlur();
                    }}
                    placeholder="Booking email"
                    placeholderTextColor={COLORS.placeholderText}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
                    editable={!loading}
                    accessibilityLabel="Booking email address"
                    maxFontSizeMultiplier={FONT_SCALE_LIMITS.form}
                  />
                </View>
              ) : null}
  </>;
}

export function LoginErrorPanel({
  errorState, handleOfflineCtaPress, loading, setShowRecoverySteps, showRecoverySteps,
}) {
  return <>
              {errorState ? (
                <View style={styles.errorContainer} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                  <MaterialCommunityIcons name="alert-circle" size={16} color={COLORS.errorRed} />
                  <View style={styles.errorBody}>
                    <Text style={styles.errorTitle}>{errorState.title}</Text>
                    <Text style={styles.errorText}>{errorState.message}</Text>
                    {errorState.recoverySteps?.length ? (
                      <TouchableOpacity
                        style={styles.disclosureButtonCompact}
                        onPress={() => setShowRecoverySteps((current) => !current)}
                        accessibilityRole="button"
                        accessibilityLabel="Show recovery steps"
                        accessibilityState={{ expanded: showRecoverySteps }}
                      >
                        <Text style={styles.disclosureErrorText}>How to recover</Text>
                        <MaterialCommunityIcons name={showRecoverySteps ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.errorRed} />
                      </TouchableOpacity>
                    ) : null}
                    {showRecoverySteps
                      ? errorState.recoverySteps.map((step) => (
                          <Text key={step} style={styles.recoveryStepText}>
                            • {step}
                          </Text>
                        ))
                      : null}
                    {errorState.showOfflineActions ? (
                      <View style={styles.errorActionsContainer}>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('retry_now')} disabled={loading} accessibilityRole="button" accessibilityLabel="Retry sign in now" accessibilityState={{ disabled: loading }}>
                          <Text style={styles.errorActionText}>Retry now</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.errorActionButton} onPress={() => handleOfflineCtaPress('verify_online')} disabled={loading} accessibilityRole="button" accessibilityLabel="Verify this code online" accessibilityState={{ disabled: loading }}>
                          <Text style={styles.errorActionText}>I’m connected, verify this code</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                </View>
              ) : null}
  </>;
}

export function LoginActions({
  buttonAnimation, handleLogin, isSubmitDisabled, loading, responsiveStyles,
  setShowOfflineHelp, setShowPrimaryHelp, showOfflineHelp, showPrimaryHelp,
}) {
  return <>
              <Animated.View style={{ transform: [{ scale: buttonAnimation }] }}>
                <TouchableOpacity
                  style={[styles.button, isSubmitDisabled && styles.buttonDisabled]}
                  onPress={handleLogin}
                  activeOpacity={0.9}
                  disabled={isSubmitDisabled}
                  accessibilityRole="button"
                  accessibilityLabel={loading ? 'Verifying your tour access' : 'Access my tour'}
                  accessibilityState={{ disabled: isSubmitDisabled, busy: loading }}
                >
                  <LinearGradient colors={[COLORS.primaryBlue, COLORS.secondaryBlue]} style={styles.buttonGradient}>
                    {loading ? (
                      <View style={styles.loadingRow}>
                        <ActivityIndicator size="small" color={COLORS.white} />
                        <Text
                          style={[styles.buttonText, responsiveStyles.buttonText]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                        >
                          Verifying...
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.buttonContent}>
                        <Text
                          style={[styles.buttonText, responsiveStyles.buttonText]}
                          numberOfLines={1}
                          adjustsFontSizeToFit
                          maxFontSizeMultiplier={FONT_SCALE_LIMITS.title}
                        >
                          Access My Tour
                        </Text>
                        <MaterialCommunityIcons name="arrow-right" size={18} color={COLORS.white} />
                      </View>
                    )}
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>

              <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowPrimaryHelp((current) => !current)} accessibilityRole="button" accessibilityLabel="Sign-in help" accessibilityState={{ expanded: showPrimaryHelp }}>
                <Text style={styles.disclosureText}>Sign-in help</Text>
                <MaterialCommunityIcons name={showPrimaryHelp ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.primaryBlue} />
              </TouchableOpacity>

              {showPrimaryHelp ? (
                <View style={styles.helpPanel}>
                  <Text style={styles.helpText}>Passengers sign in with booking reference + booking email. Drivers sign in with a D- code.</Text>
                  <Text style={styles.helpText}>Offline sign-in only works for identities previously verified on this device.</Text>
                </View>
              ) : null}

              <TouchableOpacity style={styles.disclosureButton} onPress={() => setShowOfflineHelp((current) => !current)} accessibilityRole="button" accessibilityLabel="Why offline sign-in may be unavailable" accessibilityState={{ expanded: showOfflineHelp }}>
                <Text style={styles.disclosureText}>Why can’t I log in offline?</Text>
                <MaterialCommunityIcons name={showOfflineHelp ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.primaryBlue} />
              </TouchableOpacity>
              {showOfflineHelp ? (
                <View style={styles.helpPanel}>
                  <Text style={styles.helpText}>First-time codes still need one online verification.</Text>
                  <Text style={styles.helpText}>Returning users can continue offline only when code and cached identity match exactly.</Text>
                </View>
              ) : null}
  </>;
}
