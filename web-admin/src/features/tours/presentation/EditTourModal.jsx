/**
 * Tours Manager Component
 *
 * A comprehensive tour management system that integrates with Firebase Realtime Database.
 * Matches the existing Firebase tour data structure.
 *
 * FIREBASE DATA STRUCTURE:
 * ========================
 * tours/{tourId}:
 *   - name: string
 *   - tourCode: string (e.g., "5209L 16")
 *   - days: number
 *   - startDate: string (DD/MM/YYYY)
 *   - endDate: string (DD/MM/YYYY)
 *   - isActive: boolean
 *   - driverName: string ("TBA" or driver name)
 *   - driverPhone: string
 *   - maxParticipants: number
 *   - currentParticipants: number
 *   - pickupPoints: [{location, time}]
 *   - itinerary: {title, days: [{day, title, activities: [{description, time}]}]}
 *
 * HOW TO ADD A NEW TOUR:
 * =====================
 * Method 1: Click "Add Tour" button to open the creation modal
 * Method 2: Use "Quick Create" with pre-defined templates
 * Method 3: Import tours from CSV file
 */

import { useState } from 'react';
import { notifications } from '@mantine/notifications';
import { Text, Group, Button, TextInput, Stack, ActionIcon, Tooltip, Modal, Paper, ThemeIcon, Textarea, NumberInput, Grid, CopyButton, Code, Switch } from '@mantine/core';
import { IconMap, IconEdit, IconCheck, IconCalendar, IconUsers, IconCopy } from '@tabler/icons-react';
import { parseTourPickupPointsText } from '../../../services/tourFormService';
import { DEFAULT_TOUR, updateTour, ddmmyyyyToInputFormat, inputFormatToDDMMYYYY } from '../../../services/tourService';
import { parseISODateStrict } from '../../../utils/dateUtils';
const getIsoDateFieldError = (value, fieldLabel) => {
  const parsed = parseISODateStrict(value);
  if (parsed.success) return null;
  return `${fieldLabel} must be a valid date (yyyy-MM-dd).`;
};
// Tour Card Component for grid view
export function EditTourModal({
  opened,
  onClose,
  tourId,
  tour,
  onSuccess
}) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState(() => ({
    ...DEFAULT_TOUR,
    ...tour,
    tourCode: tour?.tourCode || tourId || ''
  }));
  const [pickupPointsText, setPickupPointsText] = useState(() => (tour?.pickupPoints || []).map(pp => `${pp.time} - ${pp.location}`).join('\n'));
  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };
  const handleSave = async e => {
    e.preventDefault();
    if (!formData.name.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour name',
        color: 'red'
      });
      return;
    }
    const startDateIso = formData.startDate?.includes('-') ? formData.startDate : ddmmyyyyToInputFormat(formData.startDate);
    const endDateIso = formData.endDate?.includes('-') ? formData.endDate : ddmmyyyyToInputFormat(formData.endDate);
    const startDateError = getIsoDateFieldError(startDateIso, 'Start date');
    const endDateError = getIsoDateFieldError(endDateIso, 'End date');
    if (startDateError || endDateError) {
      notifications.show({
        title: 'Invalid Date',
        message: startDateError || endDateError,
        color: 'red'
      });
      return;
    }
    setLoading(true);
    try {
      // Parse pickup points from text
      const pickupPoints = parseTourPickupPointsText(pickupPointsText);
      const updateData = {
        name: formData.name,
        days: formData.days,
        startDate: inputFormatToDDMMYYYY(startDateIso),
        endDate: inputFormatToDDMMYYYY(endDateIso),
        isActive: formData.isActive,
        maxParticipants: formData.maxParticipants,
        pickupPoints
      };
      await updateTour(tourId, updateData);
      notifications.show({
        title: 'Tour Updated',
        message: `"${formData.name}" has been updated`,
        color: 'green'
      });
      onSuccess();
      onClose();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: error.message,
        color: 'red'
      });
    } finally {
      setLoading(false);
    }
  };
  return <Modal opened={opened} onClose={onClose} title={<Group gap="xs">
          <ThemeIcon color="blue" variant="light" size="md">
            <IconEdit size={16} />
          </ThemeIcon>
          <Text fw={600}>Edit Tour</Text>
        </Group>} size="lg" centered>
      <form onSubmit={handleSave}>
        <Stack gap="md">
          <Paper p="sm" radius="md" bg="gray.0">
            <Group gap="xs">
              <Text size="xs" c="dimmed">Tour ID:</Text>
              <Code>{tourId}</Code>
              <CopyButton value={tourId}>
                {({
                copied,
                copy
              }) => <Tooltip label={copied ? 'Copied!' : 'Copy ID'}>
                    <ActionIcon variant="subtle" size="xs" onClick={copy}>
                      <IconCopy size={12} />
                    </ActionIcon>
                  </Tooltip>}
              </CopyButton>
            </Group>
          </Paper>

          <Grid>
            <Grid.Col span={8}>
              <TextInput label="Tour Name" placeholder="e.g., Coronation Street Experience" value={formData.name} onChange={e => handleInputChange('name', e.target.value)} leftSection={<IconMap size={16} />} required />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput label="Tour Code" placeholder="e.g., 5209L 16" value={formData.tourCode || tourId || ''} readOnly />
            </Grid.Col>
          </Grid>

          <Grid>
            <Grid.Col span={4}>
              <NumberInput label="Days" value={formData.days} onChange={val => handleInputChange('days', val)} min={1} max={30} />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput label="Start Date" type="date" value={ddmmyyyyToInputFormat(formData.startDate)} onChange={e => handleInputChange('startDate', e.target.value)} leftSection={<IconCalendar size={16} />} error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.startDate), 'Start date')} required />
            </Grid.Col>
            <Grid.Col span={4}>
              <TextInput label="End Date" type="date" value={ddmmyyyyToInputFormat(formData.endDate)} onChange={e => handleInputChange('endDate', e.target.value)} leftSection={<IconCalendar size={16} />} error={getIsoDateFieldError(ddmmyyyyToInputFormat(formData.endDate), 'End date')} required />
            </Grid.Col>
          </Grid>

          <Grid>
            <Grid.Col span={6}>
              <NumberInput label="Max Participants" value={formData.maxParticipants} onChange={val => handleInputChange('maxParticipants', val)} min={Math.max(1, Number(formData.currentParticipants) || 0)} max={100} leftSection={<IconUsers size={16} />} description="Cannot be lower than booked participants" />
            </Grid.Col>
            <Grid.Col span={6}>
              <NumberInput label="Booked Participants" value={formData.currentParticipants} readOnly description="Managed automatically from booking operations" />
            </Grid.Col>
          </Grid>

          <Switch label="Tour is Active" checked={formData.isActive} onChange={e => handleInputChange('isActive', e.currentTarget.checked)} />

          <Textarea label="Pickup Points" placeholder="Enter one per line in format: HH:MM - Location" value={pickupPointsText} onChange={e => setPickupPointsText(e.target.value)} minRows={4} description="Format: TIME - LOCATION (one per line)" />

          <Group justify="flex-end" mt="md">
            <Button variant="light" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={loading} leftSection={<IconCheck size={16} />}>
              Save Changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>;
}

// Delete Confirmation Modal
