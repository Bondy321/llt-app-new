import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons.js';
import { COLORS } from '../theme';
import driverManifestCacheService from '../services/driverManifestCacheService';
import { getTourManifest } from '../services/bookingServiceRealtime';
import { normalizeTourId, resolveTourId } from '../services/tourIdentityService';
const { commandCentreModel } = require('../services/driverTourPackCommandCentre');

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

export default function DriverTourPackScreen({ packState, actionState, isConnected, tourData, driverData, onBack, onNavigate }) {
  const [tab, setTab] = useState('Overview');
  const [seatView, setSeatView] = useState('visual');
  const [manifest, setManifest] = useState(null);
  const [manifestSource, setManifestSource] = useState('none');
  const [issueText, setIssueText] = useState('');
  const [issueCategory, setIssueCategory] = useState('other');
  const [issueSeverity, setIssueSeverity] = useState('warning');
  const [workingKey, setWorkingKey] = useState(null);
  const [actionFeedback, setActionFeedback] = useState(null);
  const pack = packState?.pack;
  const driverId = driverData?.id;

  useEffect(() => {
    let active = true;
    if (!pack?.tourId || !driverId) {
      setManifest(null);
      setManifestSource('none');
      return undefined;
    }

    (async () => {
      const cached = await driverManifestCacheService.get({ tourId: pack.tourId, driverId });
      if (active && cached?.success && cached.data) {
        setManifest(cached.data);
        setManifestSource('cache');
      }
      try {
        const live = await getTourManifest(pack.tourId);
        if (!active || !live) return;
        const saved = await driverManifestCacheService.replace({ tourId: pack.tourId, driverId, manifest: live });
        if (!active) return;
        if (saved?.success) {
          setManifest(saved.data);
          setManifestSource('live');
        }
      } catch (_) {
        // Cache-first behavior is intentional: a network failure must not clear
        // the complete last-known-good manifest.
      }
    })();
    return () => { active = false; };
  }, [pack?.revision, pack?.tourId, driverId]);

  const model = useMemo(() => commandCentreModel(pack, manifest), [pack, manifest]);
  const assignedTourId = normalizeTourId(resolveTourId(
    driverData?.assignedTourId,
    driverData?.currentTourId,
    driverData?.driverAssignedTourId,
    driverData?.assignedTourCode,
    driverData?.currentTourCode,
  ));
  const identityMatches = Boolean(pack?.tourId && assignedTourId && normalizeTourId(pack.tourId) === assignedTourId);
  const state = packPresentation(packState?.state);
  const actions = actionState?.actions || {};
  const change = actionState?.change?.revision === pack?.revision ? actionState.change : null;
  const changedSectionText = change?.changedSections?.map((section) => CHANGE_SECTION_LABELS[section] || section).join(', ') || '';
  const submittedIssues = recordValues(actions.issues).sort((left, right) => Number(right.createdAtMs || 0) - Number(left.createdAtMs || 0));
  const runAction = async (key, operation, successMessage) => {
    if (workingKey) return;
    setWorkingKey(key);
    setActionFeedback(null);
    try {
      const result = await operation();
      setActionFeedback({
        kind: result?.success ? 'success' : 'error',
        message: result?.success
          ? (result.data?.queued ? `${successMessage} Saved offline and queued.` : successMessage)
          : (result?.error || 'The action could not be saved.'),
      });
      return result;
    } finally {
      setWorkingKey(null);
    }
  };
  const go = (screen, extra = {}) => onNavigate?.(screen, {
    tourId: pack?.tourId,
    from: 'DriverTourPack',
    isDriver: true,
    driverName: driverData?.name || 'Driver',
    ...extra,
  });

  const call = (phone) => {
    const safePhone = String(phone || '').trim().replace(/[^0-9+*#,;]/g, '');
    if (safePhone) Linking.openURL(`tel:${safePhone}`).catch(() => undefined);
  };
  const directions = (address) => {
    const query = String(address || '').trim();
    if (!query) return;
    const encoded = encodeURIComponent(query);
    const url = Platform.OS === 'ios' ? `maps://?q=${encoded}` : `geo:0,0?q=${encoded}`;
    Linking.openURL(url).catch(() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encoded}`).catch(() => undefined));
  };

  if (!pack) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.top}><ActionButton icon="arrow-left" label="Back" onPress={onBack} /></View>
        <View style={styles.empty}>
          <MaterialCommunityIcons name="briefcase-off-outline" size={48} color={COLORS.textSecondary} />
          <Text accessibilityRole="header" style={styles.emptyTitle}>{state.label}</Text>
          <Text style={styles.mutedCentered}>{state.detail} Use the existing manifest and contact dispatch if required.</Text>
          {packState?.refresh ? <ActionButton icon="refresh" label="Try again" onPress={() => packState.refresh({ force: true })} /> : null}
        </View>
      </SafeAreaView>
    );
  }

  const overview = (
    <>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>DRIVER COMMAND CENTRE</Text>
        <Text accessibilityRole="header" style={styles.title}>{pack.tour?.name || tourData?.name || pack.tourCode}</Text>
        <Text style={styles.heroText}>{pack.dateISO} • {pack.tourCode}</Text>
        <StatePill value={state.label} />
        <Text style={styles.heroText}>{state.detail}</Text>
        <Text style={styles.heroText} accessibilityLiveRegion="polite">
          {isConnected ? 'Online' : 'Offline'}
          {actionState?.pendingCount ? ` • ${actionState.pendingCount} driver action${actionState.pendingCount === 1 ? '' : 's'} waiting to sync` : ' • Driver actions synced'}
        </Text>
      </View>
      {change && actionState?.acknowledgementPending ? (
        <Section title={change.critical ? 'Critical update' : 'Updated operational information'}>
          <View style={change.critical ? styles.critical : styles.warning} accessibilityRole="alert">
            <Text style={change.critical ? styles.criticalText : styles.warningText}>
              Revision {change.revision} changed: {changedSectionText || 'operational information'}.
              {change.requiresAcknowledgement ? ' You must acknowledge this update before continuing.' : ' Review and acknowledge the updated sections.'}
            </Text>
          </View>
          <ActionButton
            icon="check-decagram-outline"
            label={`Acknowledge revision ${change.revision}`}
            disabled={Boolean(workingKey)}
            onPress={() => runAction('acknowledge', actionState.acknowledge, 'Revision acknowledged.')}
          />
        </Section>
      ) : null}
      <Section title="Departure check">
        <View style={identityMatches ? styles.ok : styles.critical} accessibilityRole="alert">
          <Text style={identityMatches ? styles.okText : styles.criticalText}>
            {identityMatches
              ? `Correct tour confirmed: ${pack.tourCode} on ${pack.dateISO}.`
              : 'Assignment and Tour Pack do not agree. Stop and contact dispatch.'}
          </Text>
        </View>
        <View style={styles.grid}>
          {[
            [pack.tourCode, 'Assigned tour'],
            ['Stored', 'Offline readiness'],
            [model.unresolved, 'Unresolved items'],
            [`${model.progress.boarded}/${model.progress.total}`, 'Boarded'],
          ].map(([value, label]) => (
            <View key={label} style={styles.metric}>
              <Text style={styles.metricValue}>{value}</Text>
              <Text style={styles.muted}>{label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.muted}>Manifest: {manifestSource === 'live' ? 'live and cached' : manifestSource === 'cache' ? 'offline snapshot' : 'not cached yet'}</Text>
      </Section>
      <Section title="What happens next">
        {model.nextEvent ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{model.nextEvent.title}</Text>
            <Text style={styles.muted}>{when(model.nextEvent.dateISO, model.nextEvent.time)} • {model.nextEvent.subtitle || model.nextEvent.type}</Text>
          </View>
        ) : <EmptyMessage>No future event is published. Check with dispatch for the current plan.</EmptyMessage>}
      </Section>
      <Section title="Pack quality">
        {model.qualityIssues.length ? model.qualityIssues.map((issue) => (
          <View key={issue} style={styles.warning}><Text style={styles.warningText}>{issue}</Text></View>
        )) : <View style={styles.ok}><Text style={styles.okText}>Published pickup, passenger and seat facts are matched.</Text></View>}
      </Section>
      <Section title="Operational issues">
        {submittedIssues.length ? submittedIssues.map((issue) => (
          <View key={issue.issueId} style={issue.severity === 'critical' && issue.status !== 'resolved' ? styles.critical : styles.card}>
            <Text style={styles.cardTitle}>{String(issue.category || 'other').replace('_', ' ')} • {issue.severity}</Text>
            <Text style={styles.note}>{issue.summary}</Text>
            <Text style={styles.muted}>Status: {String(issue.status || 'open').replace('_', ' ')}</Text>
          </View>
        )) : <EmptyMessage>No driver issues have been reported for this departure.</EmptyMessage>}
        <Text style={styles.fieldLabel}>Issue category</Text>
        <View style={styles.row}>
          {ISSUE_CATEGORIES.map(([value, label]) => (
            <ActionButton key={value} icon="tag-outline" label={label} selected={issueCategory === value} onPress={() => setIssueCategory(value)} />
          ))}
        </View>
        <Text style={styles.fieldLabel}>Priority</Text>
        <View style={styles.row}>
          {ISSUE_SEVERITIES.map(([value, label]) => (
            <ActionButton key={value} icon={value === 'critical' ? 'alert-octagon-outline' : 'alert-circle-outline'} label={label} selected={issueSeverity === value} onPress={() => setIssueSeverity(value)} />
          ))}
        </View>
        <TextInput
          accessibilityLabel="Operational issue summary"
          multiline
          maxLength={240}
          onChangeText={setIssueText}
          placeholder="Describe the issue without passenger names or personal details"
          style={styles.issueInput}
          value={issueText}
        />
        <Text style={styles.muted}>{issueText.length}/240 characters</Text>
        <ActionButton
          icon="message-alert-outline"
          label="Report operational issue"
          disabled={!issueText.trim() || Boolean(workingKey)}
          onPress={async () => {
            const result = await runAction('issue', () => actionState.reportIssue({
              category: issueCategory,
              severity: issueSeverity,
              summary: issueText,
            }), 'Operational issue reported.');
            if (result?.success) setIssueText('');
          }}
        />
      </Section>
      <Section title="Driver tools">
        <View style={styles.row}>
          <ActionButton icon="chat-processing-outline" label="Group chat" onPress={() => go('Chat')} />
          <ActionButton icon="map-marker-radius-outline" label="Location map" onPress={() => go('Map')} />
          <ActionButton icon="shield-alert-outline" label="Safety and support" onPress={() => go('SafetySupport', { mode: 'driver' })} />
        </View>
      </Section>
    </>
  );

  const run = (
    <>
      <Section title="Ordered pickup run">
        {model.pickups.length ? model.pickups.map(({ pickup, progress }, index) => (
          <View key={pickup.pickupId} style={styles.card}>
            <Text style={styles.cardTitle}>{index + 1}. {pickup.name}</Text>
            <Text style={styles.muted}>{when(pickup.dateISO, pickup.time)} • {pickup.address || 'Address unavailable'}</Text>
            <ProgressText progress={progress} />
            {pickup.pickupId !== '__unassigned__' ? (
              <StateControls
                label={pickup.name}
                current={actions.pickupStops?.[pickup.pickupId]?.state || 'PENDING'}
                disabled={Boolean(workingKey)}
                values={[
                  ['PENDING', 'Reset', 'backup-restore'],
                  ['ARRIVED', 'Arrived', 'map-marker-check-outline'],
                  ['COMPLETED', 'Complete', 'check-circle-outline'],
                  ['SKIPPED', 'Skip', 'skip-next-outline'],
                ]}
                onChange={(progressState) => runAction(
                  `pickup:${pickup.pickupId}`,
                  () => actionState.setPickup(pickup.pickupId, progressState),
                  `${pickup.name} marked ${progressState.toLowerCase()}.`,
                )}
              />
            ) : null}
            <Text style={styles.muted}>{pickup.bookingCount} booking{pickup.bookingCount === 1 ? '' : 's'} • {pickup.passengerCount} report passenger{pickup.passengerCount === 1 ? '' : 's'}</Text>
          </View>
        )) : <EmptyMessage>No pickup run is published.</EmptyMessage>}
      </Section>
      <Section title="Unified operational timeline">
        {model.timeline.length ? model.timeline.map((event) => (
          <View key={event.eventId} style={styles.timeline}>
            <View style={styles.dot} />
            <View style={styles.grow}>
              <Text style={styles.cardTitle}>{event.title}</Text>
              <Text style={styles.muted}>{when(event.dateISO, event.time)} • {event.subtitle || event.type}</Text>
              {event.reference ? <Text style={styles.muted}>Ref: {event.reference}</Text> : null}
              {event.notes ? <Text style={styles.note}>{event.notes}</Text> : null}
            </View>
          </View>
        )) : <EmptyMessage>No timeline events are published.</EmptyMessage>}
      </Section>
      <ActionButton icon="account-group-outline" label="Open authoritative boarding manifest" onPress={() => go('PassengerManifest')} />
    </>
  );

  const people = (
    <>
      <Section title="Passenger manifest by pickup">
        {model.pickups.length ? model.pickups.map(({ pickup, passengers }) => (
          <View key={pickup.pickupId} style={styles.card}>
            <Text style={styles.cardTitle}>{pickup.name} • {pickup.time || 'TBC'}</Text>
            {passengers.length ? passengers.map((passenger) => {
              const lead = pack.contacts?.bookingLeads?.[passenger.bookingLeadContactId];
              return (
                <View key={passenger.passengerKey} style={styles.person} accessibilityLabel={`${passenger.name}, seat ${passenger.seatLabel || 'unverified'}, ${passenger.displayState}`}>
                  <View style={styles.grow}>
                    <Text style={styles.cardTitle}>{passenger.name}</Text>
                    <Text style={styles.muted}>Seat {passenger.seatLabel || 'unverified'} • {passenger.sourceState === 'MATCHED' ? 'Pickup confirmed' : 'Needs attention'}</Text>
                    {lead?.phone ? <ActionButton icon="phone-outline" label={`Call booking lead for ${passenger.bookingRef}`} onPress={() => call(lead.phone)} /> : null}
                  </View>
                  <StatePill value={passenger.displayState} />
                </View>
              );
            }) : <Text style={styles.muted}>No passengers are assigned to this stop.</Text>}
          </View>
        )) : <EmptyMessage>No passenger groups are published.</EmptyMessage>}
      </Section>
      <ActionButton icon="account-group-outline" label="Open authoritative boarding manifest" onPress={() => go('PassengerManifest')} />
      <Section title="Coach seating">
        <View style={styles.row}>
          <ActionButton icon="view-grid-outline" label="Visual seats" selected={seatView === 'visual'} onPress={() => setSeatView('visual')} />
          <ActionButton icon="format-list-bulleted" label="Accessible seat list" selected={seatView === 'list'} onPress={() => setSeatView('list')} />
        </View>
        {pack.quality?.suppressSeatMap ? (
          <View style={styles.warning} accessibilityRole="alert"><Text style={styles.warningText}>Seat conflict: the visual seat map is withheld. Use the accessible list and contact dispatch.</Text></View>
        ) : null}
        {!model.seats.length ? <EmptyMessage>No seat layout is published.</EmptyMessage> : null}
        {model.seats.length && seatView === 'visual' && !pack.quality?.suppressSeatMap ? (
          <CoachSeatMap rows={model.seatRows} />
        ) : model.seats.length ? (
          <View>{model.seats.map((seat) => (
            <View key={seat.seatId} accessible accessibilityLabel={`Seat ${seat.label}: ${seat.displayState}`} style={styles.seatList}>
              <Text style={styles.cardTitle}>Seat {seat.label}</Text>
              <Text style={styles.muted}>{seat.passenger?.name || 'Empty'} • {seat.displayState}</Text>
            </View>
          ))}</View>
        ) : null}
      </Section>
    </>
  );

  const hotels = recordValues(pack.hotels);
  const services = recordValues(pack.services);
  const contacts = [...recordValues(pack.coach?.details), ...recordValues(pack.contacts?.operational)];
  const tour = (
    <>
      <Section title="Hotels">
        {hotels.length ? hotels.map((hotel) => (
          <View key={hotel.hotelId} style={styles.card}>
            <Text style={styles.cardTitle}>{hotel.name}</Text>
            <Text style={styles.muted}>{[hotel.address, `${hotel.nights} night(s)`, hotel.boardBasis].filter(Boolean).join(' • ')}</Text>
            <View style={styles.row}>
              {hotel.phone ? <ActionButton icon="phone-outline" label={`Call ${hotel.name}`} onPress={() => call(hotel.phone)} /> : null}
              {hotel.address ? <ActionButton icon="directions" label={`Directions to ${hotel.name}`} onPress={() => directions(`${hotel.name}, ${hotel.address}`)} /> : null}
            </View>
            <StateControls
              label={hotel.name}
              current={actions.hotelCompletion?.[hotel.hotelId]?.state || 'PENDING'}
              disabled={Boolean(workingKey)}
              values={[
                ['PENDING', 'Reset', 'backup-restore'],
                ['COMPLETED', 'Complete', 'check-circle-outline'],
                ['SKIPPED', 'Skip', 'skip-next-outline'],
              ]}
              onChange={(completionState) => runAction(
                `hotel:${hotel.hotelId}`,
                () => actionState.setHotel(hotel.hotelId, completionState),
                `${hotel.name} marked ${completionState.toLowerCase()}.`,
              )}
            />
          </View>
        )) : <EmptyMessage>No hotel information is published.</EmptyMessage>}
      </Section>
      <Section title="Services">
        {services.length ? services.map((service) => (
          <View key={service.serviceId} style={styles.card}>
            <Text style={styles.cardTitle}>{service.description}</Text>
            <Text style={styles.muted}>{when(service.dateISO, service.time)} • {service.supplier || service.type}</Text>
            {service.bookingRef ? <Text style={styles.muted}>Ref: {service.bookingRef}</Text> : null}
            {service.notes ? <Text style={styles.note}>{service.notes}</Text> : null}
            <StateControls
              label={service.description}
              current={actions.serviceCompletion?.[service.serviceId]?.state || 'PENDING'}
              disabled={Boolean(workingKey)}
              values={[
                ['PENDING', 'Reset', 'backup-restore'],
                ['COMPLETED', 'Complete', 'check-circle-outline'],
                ['SKIPPED', 'Skip', 'skip-next-outline'],
              ]}
              onChange={(completionState) => runAction(
                `service:${service.serviceId}`,
                () => actionState.setService(service.serviceId, completionState),
                `${service.description} marked ${completionState.toLowerCase()}.`,
              )}
            />
          </View>
        )) : <EmptyMessage>No service information is published.</EmptyMessage>}
      </Section>
      <Section title="Coach and approved contacts">
        {contacts.length ? contacts.map((contact) => {
          const name = contact.company || contact.name || 'Operational contact';
          return (
            <View key={contact.coachDetailId || contact.contactId} style={styles.card}>
              <Text style={styles.cardTitle}>{name}</Text>
              <Text style={styles.muted}>{contact.reference || contact.notes || contact.type || 'Operational contact'}</Text>
              {contact.phone ? <ActionButton icon="phone-outline" label={`Call ${name}`} onPress={() => call(contact.phone)} /> : null}
            </View>
          );
        }) : <EmptyMessage>No coach or operational contacts are published.</EmptyMessage>}
      </Section>
      <Section title="Itineraries">
        {['client', 'driver'].map((kind) => (
          <View key={kind} style={styles.card}>
            <Text style={styles.cardTitle}>{pack.itineraries?.[kind]?.title || (kind === 'driver' ? 'Confidential driver itinerary' : 'Client itinerary')}</Text>
            <Text style={styles.itineraryLabel}>{kind === 'driver' ? 'CONFIDENTIAL — DRIVER ONLY' : 'CLIENT-FACING PLAN'}</Text>
            <Text style={styles.note}>{pack.itineraries?.[kind]?.text || 'Not published.'}</Text>
          </View>
        ))}
      </Section>
    </>
  );

  const contents = { Overview: overview, Run: run, People: people, Tour: tour };
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.top}>
        <ActionButton icon="arrow-left" label="Back to driver home" onPress={onBack} />
        <Text accessibilityRole="header" style={styles.topTitle}>Tour pack</Text>
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {TABS.map((item) => (
          <TouchableOpacity
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item }}
            accessibilityLabel={`${item} tab`}
            onPress={() => setTab(item)}
            style={[styles.tab, tab === item && styles.selectedTab]}
          >
            <Text style={[styles.tabText, tab === item && styles.selectedTabText]}>{item}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {actionFeedback ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole={actionFeedback.kind === 'error' ? 'alert' : undefined}
          style={[styles.actionFeedback, actionFeedback.kind === 'error' ? styles.critical : styles.ok]}
        >
          <Text style={actionFeedback.kind === 'error' ? styles.criticalText : styles.feedback}>{actionFeedback.message}</Text>
        </View>
      ) : actionState?.error ? (
        <View accessibilityRole="alert" style={[styles.actionFeedback, styles.critical]}>
          <Text style={styles.criticalText}>{actionState.error}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.content}>{contents[tab]}</ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  top: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 },
  topTitle: { fontSize: 18, fontWeight: '800', color: COLORS.textPrimary },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderColor: COLORS.border },
  tab: { minHeight: 48, flex: 1, alignItems: 'center', justifyContent: 'center' },
  selectedTab: { borderBottomWidth: 3, borderColor: COLORS.primary },
  tabText: { fontWeight: '700', color: COLORS.textSecondary },
  selectedTabText: { color: COLORS.primary },
  content: { padding: 16, paddingBottom: 34, gap: 16 },
  hero: { backgroundColor: COLORS.primary, borderRadius: 16, padding: 18, gap: 6 },
  eyebrow: { color: '#DCEBFF', fontWeight: '800', fontSize: 12 },
  title: { fontSize: 24, fontWeight: '800', color: '#FFFFFF' },
  heroText: { color: '#FFFFFF' },
  section: { gap: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: COLORS.textPrimary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { width: '48%', backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, minHeight: 80 },
  metricValue: { fontSize: 18, fontWeight: '800', color: COLORS.textPrimary },
  muted: { color: COLORS.textSecondary, lineHeight: 19 },
  mutedCentered: { color: COLORS.textSecondary, lineHeight: 20, textAlign: 'center' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 13, gap: 6 },
  emptyCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 13 },
  cardTitle: { fontWeight: '700', color: COLORS.textPrimary },
  warning: { backgroundColor: '#FFF7E6', padding: 12, borderRadius: 10 },
  warningText: { color: '#92400E', lineHeight: 20 },
  critical: { backgroundColor: '#FEF2F2', padding: 12, borderRadius: 10 },
  criticalText: { color: '#991B1B', fontWeight: '700', lineHeight: 20 },
  ok: { backgroundColor: '#ECFDF3', padding: 12, borderRadius: 10 },
  okText: { color: '#166534', lineHeight: 20 },
  button: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: '#EEF5FF', flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start' },
  buttonSelected: { borderWidth: 2, borderColor: COLORS.primary },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { fontWeight: '700', color: COLORS.primary },
  buttonTextDisabled: { color: COLORS.textSecondary },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start', backgroundColor: '#FFFFFF' },
  pillText: { fontWeight: '800', fontSize: 12 },
  timeline: { flexDirection: 'row', gap: 10, paddingVertical: 9 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: COLORS.primary, marginTop: 4 },
  grow: { flex: 1 },
  note: { color: COLORS.textPrimary, lineHeight: 20 },
  fieldLabel: { color: COLORS.textPrimary, fontWeight: '800', marginTop: 4 },
  issueInput: { minHeight: 112, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, backgroundColor: '#FFFFFF', color: COLORS.textPrimary, padding: 12, textAlignVertical: 'top' },
  feedback: { color: '#166534', fontWeight: '700', lineHeight: 20 },
  itineraryLabel: { color: COLORS.textSecondary, fontWeight: '800', fontSize: 11 },
  person: { flexDirection: 'row', gap: 8, justifyContent: 'space-between', paddingVertical: 9, borderTopWidth: 1, borderColor: '#EEF0F3' },
  actionFeedback: { marginHorizontal: 16, marginTop: 10 },
  seatMap: { gap: 8 },
  coachDirection: { color: COLORS.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textAlign: 'center' },
  seatRow: { flexDirection: 'row', alignItems: 'stretch', width: '100%' },
  seatSide: { flex: 1, flexDirection: 'row', gap: 6 },
  aisle: { width: 26 },
  backSeatRow: { flexDirection: 'row', gap: 5, width: '100%' },
  seat: { flex: 1, minWidth: 0, minHeight: 64, borderWidth: 2, borderRadius: 10, alignItems: 'center', justifyContent: 'center', padding: 4 },
  backSeat: { minHeight: 60 },
  seatState: { fontSize: 11, fontWeight: '800', textAlign: 'center' },
  seatList: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, minHeight: 48, marginBottom: 7 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 14 },
  emptyTitle: { fontSize: 22, fontWeight: '800', color: COLORS.textPrimary, textAlign: 'center' },
});
