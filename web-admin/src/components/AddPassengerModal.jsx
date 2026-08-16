import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Divider,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconPlus,
  IconTrash,
  IconUserPlus,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  createEmptyPassenger,
  createEmptyPassengerDraft,
  createManualPassengerBooking,
  validateManualPassengerDraft,
} from '../services/passengerService';
import {
  formatDateToISO,
  parseUKDateStrict,
} from '../utils/dateUtils';

const getTourStartDateForInput = (tour) => {
  const parsed = parseUKDateStrict(tour?.startDate || '');
  return parsed.success ? formatDateToISO(parsed.date) : '';
};

export default function AddPassengerModal({
  opened,
  onClose,
  tours,
  initialTourId = '',
  onSuccess,
}) {
  const [draft, setDraft] = useState(() => createEmptyPassengerDraft(initialTourId));
  const [submitting, setSubmitting] = useState(false);
  const [createdBooking, setCreatedBooking] = useState(null);
  const wasOpenedRef = useRef(false);

  useEffect(() => {
    if (opened && !wasOpenedRef.current) {
      const tour = tours[initialTourId];
      setDraft({
        ...createEmptyPassengerDraft(initialTourId),
        pickupDate: getTourStartDateForInput(tour),
      });
      setCreatedBooking(null);
    }
    wasOpenedRef.current = opened;
  }, [initialTourId, opened, tours]);

  const validation = useMemo(
    () => validateManualPassengerDraft(draft, tours),
    [draft, tours],
  );

  const tourOptions = useMemo(() => (
    Object.entries(tours)
      .sort(([, left], [, right]) => String(left.startDate || '').localeCompare(String(right.startDate || '')))
      .map(([tourId, tour]) => ({
        value: tourId,
        label: `${tour.tourCode || tourId} - ${tour.name || 'Unnamed tour'} (${tour.startDate || 'date missing'})`,
        disabled: tour.isActive === false,
      }))
  ), [tours]);

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const handleTourChange = (tourId) => {
    const nextTourId = tourId || '';
    const tour = tours[nextTourId];
    setDraft((current) => ({
      ...current,
      tourId: nextTourId,
      pickupDate: getTourStartDateForInput(tour),
    }));
  };

  const updatePassenger = (index, field, value) => {
    setDraft((current) => ({
      ...current,
      passengers: current.passengers.map((passenger, passengerIndex) => (
        passengerIndex === index ? { ...passenger, [field]: value } : passenger
      )),
    }));
  };

  const addPassengerRow = () => {
    setDraft((current) => ({
      ...current,
      passengers: [...current.passengers, createEmptyPassenger()],
    }));
  };

  const removePassengerRow = (index) => {
    setDraft((current) => ({
      ...current,
      passengers: current.passengers.filter((_, passengerIndex) => passengerIndex !== index),
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!validation.valid || submitting) return;

    setSubmitting(true);
    try {
      const result = await createManualPassengerBooking(draft, tours);
      setCreatedBooking(result);
      onSuccess?.(result);
      notifications.show({
        title: 'Passenger booking created',
        message: `${result.bookingRef} can now sign in to ${result.tourCode}.`,
        color: 'green',
      });
    } catch (error) {
      notifications.show({
        title: 'Passenger was not added',
        message: error.message,
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    setCreatedBooking(null);
    setDraft(createEmptyPassengerDraft(initialTourId));
    onClose();
  };

  const invalidSectionCount = Object.keys(validation.errors).length;

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={(
        <Group gap="xs">
          <ThemeIcon color="green" variant="light">
            <IconUserPlus size={18} />
          </ThemeIcon>
          <Text fw={600}>Add Passenger Booking</Text>
        </Group>
      )}
      size="xl"
      centered
      closeOnClickOutside={!submitting}
    >
      {createdBooking ? (
        <Stack gap="lg">
          <Alert color="green" icon={<IconCheck size={18} />} title="Ready for app login">
            The booking, login identity, pickup data, tour counts, and manifest row were created together.
          </Alert>

          <Paper withBorder p="lg" radius="md">
            <Stack gap="md">
              <Group justify="space-between">
                <div>
                  <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Tour</Text>
                  <Text fw={600}>{createdBooking.tourCode}</Text>
                </div>
                <Badge color="green">{createdBooking.passengerCount} passenger{createdBooking.passengerCount === 1 ? '' : 's'}</Badge>
              </Group>

              <Divider />

              <div>
                <Text size="xs" c="dimmed" mb={4}>Booking reference</Text>
                <Group gap="xs">
                  <Code>{createdBooking.bookingRef}</Code>
                  <CopyButton value={createdBooking.bookingRef}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy booking reference'}>
                        <ActionIcon color={copied ? 'green' : 'blue'} variant="light" onClick={copy}>
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              </div>

              <div>
                <Text size="xs" c="dimmed" mb={4}>Login email</Text>
                <Group gap="xs">
                  <Code>{createdBooking.email}</Code>
                  <CopyButton value={createdBooking.email}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy login email'}>
                        <ActionIcon color={copied ? 'green' : 'blue'} variant="light" onClick={copy}>
                          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              </div>
            </Stack>
          </Paper>

          <Group justify="flex-end">
            <Button onClick={handleClose}>Done</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={handleSubmit}>
          <Stack gap="lg">
            <Alert color="blue" variant="light">
              Every field is required. The booking is only created after the server confirms the tour,
              booking reference, dates, and seats are viable.
            </Alert>

            <Select
              label="Tour code"
              placeholder="Select the passenger's tour"
              data={tourOptions}
              value={draft.tourId}
              onChange={handleTourChange}
              searchable
              limit={50}
              required
              error={validation.errors.tourId}
            />

            <Grid>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Booking reference"
                  placeholder="e.g., T123456"
                  value={draft.bookingRef}
                  onChange={(event) => updateDraft('bookingRef', event.currentTarget.value.toUpperCase())}
                  required
                  error={validation.errors.bookingRef}
                  description="Must be globally unique and will be used to sign in."
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Login email"
                  type="email"
                  placeholder="reviewer@example.com"
                  value={draft.email}
                  onChange={(event) => updateDraft('email', event.currentTarget.value)}
                  required
                  error={validation.errors.email}
                />
              </Grid.Col>
            </Grid>

            <Grid>
              <Grid.Col span={{ base: 12, sm: 3 }}>
                <TextInput
                  label="Pickup date"
                  type="date"
                  value={draft.pickupDate}
                  onChange={(event) => updateDraft('pickupDate', event.currentTarget.value)}
                  required
                  error={validation.errors.pickupDate}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 3 }}>
                <TextInput
                  label="Pickup time"
                  type="time"
                  value={draft.pickupTime}
                  onChange={(event) => updateDraft('pickupTime', event.currentTarget.value)}
                  required
                  error={validation.errors.pickupTime}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Pickup location"
                  placeholder="e.g., Buchanan Bus Station, Stance 25"
                  value={draft.pickupLocation}
                  onChange={(event) => updateDraft('pickupLocation', event.currentTarget.value)}
                  required
                  error={validation.errors.pickupLocation}
                />
              </Grid.Col>
            </Grid>

            <Divider label="Passengers and seats" labelPosition="left" />

            <Stack gap="md">
              {draft.passengers.map((passenger, index) => {
                const rowErrors = validation.errors.passengerRows?.[index] || {};
                return (
                  <Paper key={index} p="md" radius="md" withBorder>
                    <Group justify="space-between" mb="sm">
                      <Text fw={600}>Passenger {index + 1}</Text>
                      {draft.passengers.length > 1 && (
                        <Tooltip label="Remove passenger">
                          <ActionIcon
                            color="red"
                            variant="light"
                            onClick={() => removePassengerRow(index)}
                            aria-label={`Remove passenger ${index + 1}`}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Group>
                    <Grid>
                      <Grid.Col span={{ base: 12, sm: 6 }}>
                        <TextInput
                          label="Full name"
                          placeholder="Passenger full name"
                          value={passenger.name}
                          onChange={(event) => updatePassenger(index, 'name', event.currentTarget.value)}
                          required
                          error={rowErrors.name}
                        />
                      </Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 2 }}>
                        <NumberInput
                          label="Seat number"
                          placeholder="19"
                          value={passenger.seatNumber}
                          onChange={(value) => updatePassenger(index, 'seatNumber', value)}
                          min={1}
                          max={tours[draft.tourId]?.maxParticipants || 53}
                          allowDecimal={false}
                          required
                          error={rowErrors.seatNumber}
                        />
                      </Grid.Col>
                      <Grid.Col span={{ base: 12, sm: 4 }}>
                        <TextInput
                          label="Phone number"
                          type="tel"
                          placeholder="+44 7700 900000"
                          value={passenger.phone}
                          onChange={(event) => updatePassenger(index, 'phone', event.currentTarget.value)}
                          required
                          error={rowErrors.phone}
                        />
                      </Grid.Col>
                    </Grid>
                  </Paper>
                );
              })}
            </Stack>

            <Button
              variant="light"
              leftSection={<IconPlus size={16} />}
              onClick={addPassengerRow}
              disabled={draft.passengers.length >= 53}
            >
              Add another passenger to this booking
            </Button>

            {!validation.valid && (
              <Alert color="orange" icon={<IconAlertCircle size={18} />}>
                Complete all required details before creation. {invalidSectionCount} section{invalidSectionCount === 1 ? '' : 's'} still need attention.
              </Alert>
            )}

            <Group justify="flex-end">
              <Button variant="light" onClick={handleClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                leftSection={<IconUserPlus size={16} />}
                loading={submitting}
                disabled={!validation.valid}
              >
                Add Passenger Booking
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
