export const createDriverTourPackPresentation = ({
  COLORS,
  MaterialCommunityIcons,
  Text,
  TouchableOpacity,
  View,
  styles,
}) => {
const formatPositiveQuantity = (value) => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return '';
  return Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(2)));
};

const TABS = Object.freeze(['Overview', 'Run', 'People', 'Tour']);
const ISSUE_CATEGORIES = Object.freeze([
  ['delay', 'Delay'], ['vehicle', 'Vehicle'], ['pickup', 'Pickup'], ['passenger', 'Passenger'],
  ['hotel', 'Hotel'], ['supplier', 'Supplier'], ['accessibility', 'Accessibility'], ['other', 'Other'],
]);
const ISSUE_SEVERITIES = Object.freeze([['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']]);
const CHANGE_SECTION_LABELS = Object.freeze({
  status: 'tour status', tour: 'tour details', pickups: 'pickup run', passengers: 'passenger facts',
  seats: 'seating', timeline: 'timeline', hotels: 'hotels', services: 'services', coach: 'coach details',
  contacts: 'contacts', itineraries: 'itineraries', coverage: 'report coverage', quality: 'data quality',
});
const SEAT_COLOURS = Object.freeze({
  Empty: '#6B7280',
  Pending: '#B45309',
  Boarded: '#15803D',
  'No-show': '#B91C1C',
  Unmatched: '#7C3AED',
  Conflict: '#DC2626',
});
const PACK_STATE = Object.freeze({
  ready: { label: 'Ready offline', detail: 'A validated copy is stored on this device.' },
  stale: { label: 'Stale pack', detail: 'Use with care and ask dispatch to confirm recent changes.' },
  incomplete: { label: 'Incomplete pack', detail: 'Some report facts are missing or unresolved.' },
  expired: { label: 'Expired pack', detail: 'This operational copy is no longer available.' },
  withdrawn: { label: 'Tour withdrawn', detail: 'Do not operate from this pack. Contact dispatch.' },
  missing: { label: 'Pack unavailable', detail: 'No valid pack is stored for this assignment.' },
  failed: { label: 'Pack refresh failed', detail: 'The last valid offline copy is preserved when available.' },
});

const packPresentation = (state) => PACK_STATE[state] || { label: 'Preparing pack', detail: 'Checking this assignment.' };
const when = (date, time) => [date, time].filter(Boolean).join(' • ') || 'Time to be confirmed';
const recordValues = (value) => Object.values(value && typeof value === 'object' ? value : {});

function ActionButton({ label, icon, onPress, disabled = false, selected }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(typeof selected === 'boolean' ? { selected } : {}) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled, selected && styles.buttonSelected]}
    >
      <MaterialCommunityIcons name={icon} size={19} color={disabled ? COLORS.textSecondary : COLORS.primary} />
      <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Section({ title, children }) {
  return <View style={styles.section}><Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function StatePill({ value }) {
  const color = SEAT_COLOURS[value] || COLORS.primary;
  return <View style={[styles.pill, { borderColor: color }]}><Text style={[styles.pillText, { color }]}>{value}</Text></View>;
}

function EmptyMessage({ children }) {
  return <View style={styles.emptyCard}><Text style={styles.muted}>{children}</Text></View>;
}

function SeatCard({ seat, backRow = false }) {
  return (
    <View
      accessible
      accessibilityLabel={`Seat ${seat.label}: ${seat.displayState}${seat.passenger ? `, ${seat.passenger.name}` : ''}`}
      style={[styles.seat, backRow && styles.backSeat, { borderColor: SEAT_COLOURS[seat.displayState] }]}
    >
      <Text style={styles.cardTitle}>{seat.label}</Text>
      <Text style={[styles.seatState, { color: SEAT_COLOURS[seat.displayState] }]}>{seat.displayState}</Text>
    </View>
  );
}

function CoachSeatMap({ rows }) {
  return (
    <View style={styles.seatMap}>
      <Text style={styles.coachDirection}>FRONT OF COACH</Text>
      {rows.map((row) => row.kind === 'back' ? (
        <View key={`row-${row.rowNumber}`} style={styles.backSeatRow} accessibilityLabel={`Coach back row ${row.rowNumber}`}>
          {row.seats.map((seat) => <SeatCard key={seat.seatId} seat={seat} backRow />)}
        </View>
      ) : (
        <View key={`row-${row.rowNumber}`} style={styles.seatRow} accessibilityLabel={`Coach row ${row.rowNumber}`}>
          <View style={styles.seatSide}>
            {row.left.map((seat) => <SeatCard key={seat.seatId} seat={seat} />)}
          </View>
          <View style={styles.aisle} accessibilityLabel="Coach aisle" />
          <View style={styles.seatSide}>
            {row.right.map((seat) => <SeatCard key={seat.seatId} seat={seat} />)}
          </View>
        </View>
      ))}
      <Text style={styles.coachDirection}>REAR OF COACH</Text>
    </View>
  );
}

function ProgressText({ progress }) {
  return (
    <Text style={styles.muted}>
      {progress.boarded} boarded • {progress.pending} pending • {progress.noShow} no-show
      {progress.unresolved ? ` • ${progress.unresolved} unresolved` : ''}
    </Text>
  );
}

function StateControls({ current = 'PENDING', values, onChange, disabled = false, label }) {
  return (
    <View style={styles.row} accessibilityLabel={`${label} progress controls`}>
      {values.map(([value, text, icon]) => (
        <ActionButton
          key={value}
          icon={icon}
          label={text}
          selected={current === value}
          disabled={disabled}
          onPress={() => onChange(value)}
        />
      ))}
    </View>
  );
}

  return {
    ActionButton,
    CHANGE_SECTION_LABELS,
    CoachSeatMap,
    EmptyMessage,
    formatPositiveQuantity,
    ISSUE_CATEGORIES,
    ISSUE_SEVERITIES,
    packPresentation,
    ProgressText,
    recordValues,
    Section,
    StateControls,
    StatePill,
    TABS,
    when,
  };
};
