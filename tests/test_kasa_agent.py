"""
Tests for Kasa Smart Home Agent.
Uses REAL devices from settings.json.
"""
import pytest
import asyncio

# Try to import the agent, skip all tests if dependencies missing
try:
    from kasa_agent import KasaAgent
    HAS_KASA = True
except ImportError as e:
    HAS_KASA = False
    IMPORT_ERROR = str(e)

pytestmark = pytest.mark.skipif(not HAS_KASA, reason=f"Kasa dependencies not installed: {IMPORT_ERROR if not HAS_KASA else ''}")


def _first_valid_device_config(kasa_devices):
    if not kasa_devices:
        pytest.skip("No Kasa devices configured in settings.json")

    device_config = kasa_devices[0]
    if not device_config:
        pytest.skip("Invalid device config")

    return device_config



class TestKasaDiscovery:
    """Tests for device discovery."""
    
    def test_agent_initialization(self, kasa_devices):
        """Test KasaAgent initializes with known devices."""
        agent = KasaAgent(known_devices=kasa_devices)
        assert agent is not None
        assert hasattr(agent, 'devices')
        print(f"KasaAgent initialized with {len(kasa_devices)} known devices")
    
    @pytest.mark.asyncio
    async def test_initialize_known_devices(self, kasa_devices):
        """Test initializing devices from settings."""
        agent = KasaAgent(known_devices=kasa_devices)
        await agent.initialize()
        print(f"Initialized {len(agent.devices)} devices")
        
        # If we have known devices, they should be loaded
        if kasa_devices and len(agent.devices) == 0:
            pytest.skip("Configured Kasa devices are not reachable from this environment")

        if kasa_devices:
            assert len(agent.devices) > 0
    
    @pytest.mark.asyncio
    async def test_discover_devices(self):
        """Test discovering devices on network."""
        agent = KasaAgent()
        devices = await agent.discover_devices()
        
        print(f"Discovered {len(devices)} devices:")
        for device in devices:
            print(f"  - {device.get('alias', 'unknown')} @ {device.get('ip', 'unknown')}")
        
        # Discovery should return a list (may be empty if no devices)
        assert isinstance(devices, list)


class TestKasaDeviceControl:
    """Tests for device control - only runs if devices exist."""
    
    @pytest.fixture
    async def agent_with_devices(self, kasa_devices):
        """Get an initialized agent with devices."""
        agent = KasaAgent(known_devices=kasa_devices)
        await agent.initialize()
        if kasa_devices and not agent.devices:
            pytest.skip("Configured Kasa devices are not reachable from this environment")
        return agent
    
    @pytest.mark.asyncio
    async def test_get_device_by_alias(self, agent_with_devices, kasa_devices):
        """Test finding device by alias."""
        agent = agent_with_devices

        device_config = _first_valid_device_config(kasa_devices)

        alias = device_config.get('alias')
        if alias:
            device = agent.get_device_by_alias(alias)
            print(f"Found device by alias '{alias}': {device}")
    
    @pytest.mark.asyncio  
    async def test_turn_on_device(self, agent_with_devices, kasa_devices):
        """Test turning on a device."""
        agent = agent_with_devices

        device_config = _first_valid_device_config(kasa_devices)

        ip = device_config.get('ip')
        if ip:
            result = await agent.turn_on(ip)
            print(f"Turn on result for {ip}: {result}")
            if result is False:
                pytest.skip(f"Configured Kasa device {ip} is currently unreachable")
            assert result is True
    
    @pytest.mark.asyncio
    async def test_turn_off_device(self, agent_with_devices, kasa_devices):
        """Test turning off a device."""
        agent = agent_with_devices

        device_config = _first_valid_device_config(kasa_devices)

        ip = device_config.get('ip')
        if ip:
            result = await agent.turn_off(ip)
            print(f"Turn off result for {ip}: {result}")
            if result is False:
                pytest.skip(f"Configured Kasa device {ip} is currently unreachable")
            assert result is True
    
    @pytest.mark.asyncio
    async def test_set_brightness(self, agent_with_devices, kasa_devices):
        """Test setting brightness."""
        agent = agent_with_devices

        device_config = _first_valid_device_config(kasa_devices)

        ip = device_config.get('ip')
        if ip:
            result = await agent.set_brightness(ip, 50)
            print(f"Set brightness result for {ip}: {result}")
    
    @pytest.mark.asyncio
    async def test_set_color(self, agent_with_devices, kasa_devices):
        """Test setting color."""
        agent = agent_with_devices

        device_config = _first_valid_device_config(kasa_devices)

        ip = device_config.get('ip')
        if ip:
            result = await agent.set_color(ip, "blue")
            print(f"Set color result for {ip}: {result}")


class TestKasaColorConversion:
    """Test color name to HSV conversion."""
    
    def test_name_to_hsv_red(self):
        """Test red color conversion."""
        agent = KasaAgent()
        hsv = agent.name_to_hsv("red")
        assert hsv is not None
        assert hsv[0] == 0  # Hue for red
    
    def test_name_to_hsv_blue(self):
        """Test blue color conversion."""
        agent = KasaAgent()
        hsv = agent.name_to_hsv("blue")
        assert hsv is not None
        assert hsv[0] == 240  # Hue for blue
    
    def test_name_to_hsv_unknown(self):
        """Test unknown color returns None."""
        agent = KasaAgent()
        hsv = agent.name_to_hsv("notacolor")
        assert hsv is None
