import { Text, TextInput } from 'react-native';
import { FONT_SCALE_LIMITS } from './responsiveLayout';

const mergeDefaults = (Component, defaults) => {
  Component.defaultProps = {
    ...defaults,
    ...(Component.defaultProps || {}),
  };
};

mergeDefaults(Text, {
  allowFontScaling: true,
  maxFontSizeMultiplier: FONT_SCALE_LIMITS.body,
});

mergeDefaults(TextInput, {
  allowFontScaling: true,
  maxFontSizeMultiplier: FONT_SCALE_LIMITS.form,
});
