import createDriverTourPackScreenStyles from './styles/DriverTourPackScreen.styles';
import { createDriverTourPackPresentation } from '../src/features/driver-tour-pack/presentation/driverTourPackPresentation';
import { useEffect, useMemo, useState } from 'react';
import {
  StyleSheet,
  Linking,
  Platform,
  ScrollView,
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
const { toTelephoneUrl } = require('../utils/bookingLeadPhone');
const { buildDestinationQuery, buildDirectionsUrls } = require('../utils/directions');

const styles = createDriverTourPackScreenStyles({ StyleSheet, COLORS });
const {
  ActionButton, CHANGE_SECTION_LABELS, CoachSeatMap, EmptyMessage, formatPositiveQuantity,
  ISSUE_CATEGORIES, ISSUE_SEVERITIES, packPresentation, ProgressText, recordValues, Section,
  StateControls, StatePill, TABS, when,
} = createDriverTourPackPresentation({ COLORS, MaterialCommunityIcons, Text, TouchableOpacity, View, styles });

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
    const telephoneUrl = toTelephoneUrl(phone);
    if (telephoneUrl) Linking.openURL(telephoneUrl).catch(() => undefined);
  };
  const directions = async (...destinationParts) => {
    const destination = buildDestinationQuery(destinationParts);
    const urls = buildDirectionsUrls(destination, Platform.OS);
    if (!urls) return;
    let targetUrl = urls.webUrl;
    try {
      targetUrl = urls.nativeUrl && await Linking.canOpenURL(urls.nativeUrl)
        ? urls.nativeUrl
        : urls.webUrl;
    } catch (_) {
      targetUrl = urls.webUrl;
    }
    await Linking.openURL(targetUrl).catch(() => undefined);
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
        {!model.pickupManifestAvailable ? (
          <View style={styles.warning} accessibilityRole="alert">
            <Text style={styles.warningText}>Report pickup details are withheld because reconciliation did not pass the publication safety gate. Use the authoritative boarding manifest.</Text>
          </View>
        ) : model.pickups.length ? model.pickups.map(({ pickup, progress }, index) => (
          <View key={pickup.pickupId} style={styles.card}>
            <Text style={styles.cardTitle}>{index + 1}. {pickup.name}</Text>
            <Text style={styles.muted}>{when(pickup.dateISO, pickup.time)} • {pickup.address || 'Address unavailable'}</Text>
            <ProgressText progress={progress} />
            {pickup.pickupId !== '__unassigned__' ? (
              <>
                {String(pickup.address || '').trim() ? (
                  <ActionButton
                    icon="directions"
                    label={`Directions to ${pickup.name}`}
                    onPress={() => directions(pickup.name, pickup.address)}
                  />
                ) : null}
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
              </>
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
        {!model.pickupManifestAvailable ? (
          <View style={styles.warning} accessibilityRole="alert">
            <Text style={styles.warningText}>Report passenger groups are withheld because reconciliation did not pass the publication safety gate. Continue in the authoritative boarding manifest.</Text>
          </View>
        ) : model.pickups.length ? model.pickups.map(({ pickup, passengers }) => (
          <View key={pickup.pickupId} style={styles.card}>
            <Text style={styles.cardTitle}>{pickup.name} • {pickup.time || 'TBC'}</Text>
            {passengers.length ? passengers.map((passenger) => {
              const lead = pack.contacts?.bookingLeads?.[passenger.bookingLeadContactId];
              return (
                <View key={passenger.passengerKey} style={styles.person} accessibilityLabel={`${passenger.name}, seat ${passenger.seatLabel || 'unverified'}, ${passenger.displayState}`}>
                  <View style={styles.grow}>
                    <Text style={styles.cardTitle}>{passenger.name}</Text>
                    <Text style={styles.muted}>Seat {passenger.seatLabel || 'unverified'} • {passenger.sourceState === 'MATCHED' ? 'Pickup confirmed' : 'Needs attention'}</Text>
                    {String(passenger.note || '').trim() ? <Text style={styles.note}>Driver note: {passenger.note}</Text> : null}
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
      {model.pickupManifestAvailable ? <Section title="Coach seating">
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
      </Section> : null}
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
            <Text style={styles.muted}>{[hotel.address, hotel.postcode, `${hotel.nights} night(s)`, hotel.boardBasis].filter(Boolean).join(' • ')}</Text>
            <View style={styles.row}>
              {hotel.phone ? <ActionButton icon="phone-outline" label={`Call ${hotel.name}`} onPress={() => call(hotel.phone)} /> : null}
              {(hotel.address || hotel.postcode) ? <ActionButton icon="directions" label={`Directions to ${hotel.name}`} onPress={() => directions(hotel.name, hotel.address, hotel.postcode)} /> : null}
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
            {formatPositiveQuantity(service.quantity) ? <Text style={styles.muted}>Quantity: {formatPositiveQuantity(service.quantity)}</Text> : null}
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
