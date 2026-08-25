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
import { Text, Group, Button, TextInput, Stack, Badge, ActionIcon, Modal, Loader, Center, Paper, ThemeIcon, SimpleGrid, Textarea, NumberInput, Grid, Tabs, Alert, Switch } from '@mantine/core';
import { IconMap, IconEdit, IconCalendar, IconUsers, IconPlus, IconTemplate, IconInfoCircle, IconChevronRight } from '@tabler/icons-react';
import { parseTourPickupPointsText } from '../../../services/tourFormService';
import { DEFAULT_TOUR, TOUR_TEMPLATES, createTour, createTourFromTemplate, ddmmyyyyToInputFormat, inputFormatToDDMMYYYY } from '../../../services/tourService';
import { parseISODateStrict } from '../../../utils/dateUtils';
const getIsoDateFieldError = (value, fieldLabel) => {
  const parsed = parseISODateStrict(value);
  if (parsed.success) return null;
  return `${fieldLabel} must be a valid date (yyyy-MM-dd).`;
};
// Tour Card Component for grid view
export function CreateTourModal({
  opened,
  onClose,
  onSuccess,
  userEmail
}) {
  const [activeTab, setActiveTab] = useState('manual');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    ...DEFAULT_TOUR
  });
  const [pickupPointsText, setPickupPointsText] = useState('');
  const resetForm = () => {
    setFormData({
      ...DEFAULT_TOUR
    });
    setPickupPointsText('');
    setActiveTab('manual');
  };
  const handleClose = () => {
    resetForm();
    onClose();
  };
  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };
  const handleCreateManual = async e => {
    e.preventDefault();
    if (!formData.name.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour name',
        color: 'red'
      });
      return;
    }
    if (!formData.tourCode.trim()) {
      notifications.show({
        title: 'Missing Information',
        message: 'Please enter a tour code',
        color: 'red'
      });
      return;
    }
    const startDateError = getIsoDateFieldError(formData.startDate, 'Start date');
    const endDateError = getIsoDateFieldError(formData.endDate, 'End date');
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
      const tourData = {
        ...formData,
        startDate: inputFormatToDDMMYYYY(formData.startDate),
        endDate: inputFormatToDDMMYYYY(formData.endDate),
        pickupPoints,
        itinerary: {
          title: formData.name,
          days: []
        }
      };
      const result = await createTour(tourData, userEmail);
      notifications.show({
        title: 'Tour Created',
        message: `"${formData.name}" has been created successfully`,
        color: 'green'
      });
      onSuccess(result.id);
      handleClose();
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
  const handleCreateFromTemplate = async templateKey => {
    setLoading(true);
    try {
      const result = await createTourFromTemplate(templateKey, {}, userEmail);
      notifications.show({
        title: 'Tour Created',
        message: `Tour created from "${TOUR_TEMPLATES[templateKey].name}" template`,
        color: 'green'
      });
      onSuccess(result.id);
      handleClose();
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
  return <Modal opened={opened} onClose={handleClose} title={<Group gap="xs">
          <ThemeIcon color="brand" variant="light" size="md">
            <IconPlus size={16} />
          </ThemeIcon>
          <Text fw={600}>Create New Tour</Text>
        </Group>} size="lg" centered>
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="manual" leftSection={<IconEdit size={14} />}>
            Manual Entry
          </Tabs.Tab>
          <Tabs.Tab value="templates" leftSection={<IconTemplate size={14} />}>
            From Template
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="manual">
          <form onSubmit={handleCreateManual}>
            <Stack gap="md">
              <Grid>
                <Grid.Col span={8}>
                  <TextInput label="Tour Name" placeholder="e.g., Coronation Street Experience" value={formData.name} onChange={e => handleInputChange('name', e.target.value)} leftSection={<IconMap size={16} />} required />
                </Grid.Col>
                <Grid.Col span={4}>
                  <TextInput label="Tour Code" placeholder="e.g., 5209L 16" value={formData.tourCode} onChange={e => handleInputChange('tourCode', e.target.value)} required />
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
                <Grid.Col span={12}>
                  <NumberInput label="Max Participants" value={formData.maxParticipants} onChange={val => handleInputChange('maxParticipants', val)} min={1} max={100} leftSection={<IconUsers size={16} />} />
                </Grid.Col>
              </Grid>

              <Alert icon={<IconUsers size={16} />} color="gray" variant="light">
                Booked participants starts at 0 and is maintained automatically when bookings are added.
              </Alert>

              <Switch label="Tour is Active" checked={formData.isActive} onChange={e => handleInputChange('isActive', e.currentTarget.checked)} />

              <Textarea label="Pickup Points" placeholder="Enter one per line in format: HH:MM - Location&#10;e.g., 06:30 - Dundee - Seagate Bus Station" value={pickupPointsText} onChange={e => setPickupPointsText(e.target.value)} minRows={4} description="Format: TIME - LOCATION (one per line)" />

              <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                The tour will be created with driver set to "TBA". You can assign a driver after creation.
                The itinerary starts empty and remains unchanged by this form.
              </Alert>

              <Group justify="flex-end" mt="md">
                <Button variant="light" onClick={handleClose}>Cancel</Button>
                <Button type="submit" loading={loading} leftSection={<IconPlus size={16} />}>
                  Create Tour
                </Button>
              </Group>
            </Stack>
          </form>
        </Tabs.Panel>

        <Tabs.Panel value="templates">
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Select a pre-configured tour template to quickly create a new tour.
              You can edit the details after creation.
            </Text>

            <SimpleGrid cols={1} spacing="md">
              {Object.entries(TOUR_TEMPLATES).map(([key, template]) => <Paper key={key} p="md" radius="md" withBorder style={{
              cursor: 'pointer'
            }} onClick={() => handleCreateFromTemplate(key)}>
                  <Group justify="space-between">
                    <Group gap="md">
                      <ThemeIcon color="brand" variant="light" size="xl" radius="md">
                        <IconMap size={24} />
                      </ThemeIcon>
                      <div>
                        <Text fw={600}>{template.name}</Text>
                        <Group gap="xs" mt={4}>
                          <Badge size="xs" variant="light">
                            {template.days} Day{template.days > 1 ? 's' : ''}
                          </Badge>
                          <Badge size="xs" variant="light" color="blue">
                            {template.maxParticipants} max
                          </Badge>
                          <Badge size="xs" variant="light" color="green">
                            {template.pickupPoints?.length || 0} pickups
                          </Badge>
                        </Group>
                      </div>
                    </Group>
                    <ActionIcon variant="light" size="lg" color="brand">
                      <IconChevronRight size={18} />
                    </ActionIcon>
                  </Group>
                </Paper>)}
            </SimpleGrid>

            {loading && <Center py="md">
                <Loader size="sm" />
              </Center>}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>;
}

// Edit Tour Modal Component
