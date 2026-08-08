# Measurement Application

> Converted from `Measurement Application.pdf` (C-Bus Measurement Application protocol documentation).

# **C-Bus Application Messages & Behaviour**

# **Chapter 28 – Measurement**

Document Number: CBUS-APP/28 Issue: 1.2 Date: 13 February 2007

### Comments on this document should be addressed to:

Engineering Manager
Clipsal Integrated Systems
PO Box 103 Hindmarsh
South Australia 5007

Copyright © 2002 – 2007 Clipsal Australia Pty Ltd

---

## 28 Measurement Application

### 28.1 Application ID

`$E4` (228 decimal)

### 28.2 Description

The Measurement Application is used to obtain information using basic units of voltage,
current and resistance. This information is scaled as required to obtain units which can
relate to real world quantities such as temperature, liquid level, light level, etc.

Measurement Application devices are typically categorised as:

a. **input units**, which measure the quantities concerned; and
b. **output units**, which are used to display or otherwise use the measured information.

### 28.3 Document Convention

Numbers are shown in decimal (base ten) with no other special prefixes or indications.

Binary numbers (base 2) are shown with the prefix `%`.

Hexadecimal numbers (base 16) are shown with the prefix `$`.

Example: `157 = %10011101 = $9D`

### 28.4 Message Structure

C-Bus messages can be up to 64 bytes long[^1], though in practice Measurement Application
messages are no more than 5 bytes long. Measurement Application messages have the form:

| Byte 0  | Increasing byte numbers → |
|---------|---------------------------|
| Command | Arguments                 |

The number of arguments is variable, and is dependent on the command.

The command byte is broken into bit-fields to support encoding of a command and the number
of bytes following as parameters. The short argument command form is:

| bit 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
|---|---|---|---|---|---|---|---|
| 0 | C | C | C | C | L | L | L |

Where "C" represents a bit of a command, and "L" represents a bit of the length.

The following commands are supported:

- `%0001` = MEASUREMENT EVENT
- All others reserved.

The length field reflects the number of arguments.

[^1]: Due to a limitation in the C-Bus PC interface, a single message cannot be longer than 21 bytes.

### 28.5 Defined Messages

All messages listed are mandatory for C-Bus measurement systems, unless explicitly stated
otherwise.

#### 28.5.1 Measurement Data Messages

Measurement Data Messages are sent by a Measurement Device either:

a. Based on an elapsed time interval between measurements;
b. Based on a change in the measured value since the last transmission; or
c. In response to a specific request for an update (using the Control Trigger Application).

##### 28.5.1.1 Channel measurement data

| Field | Value |
|---|---|
| Command | `%0 0001 110` (`$0E`) |
| Arguments | `<Device ID>, <Channel>, <Units>, <Multiplier>, <MSB>, <LSB>` |
| Meaning | Measurement data for a channel. |
| Originator | Measurement device. |

Notes: the 6 argument bytes have the following format:

| Argument | Description |
|---|---|
| `<Device ID>` | Number identifying this measurement device. |
| `<Channel>` | The input channel number of the measurement device. |
| `<Units>` | Number identifying measurement units (see §28.5.1.2). |
| `<Multiplier>` | Power of ten unit multiplier, signed 2's complement. |
| `<MSB>`, `<LSB>` | Most & least significant byte of scaled measurement, the two bytes forming a signed 2's complement number. |

**Decoded value:** `value = int16(MSB, LSB) × 10^Multiplier`, in the unit identified by `<Units>`.

##### 28.5.1.2 Units definition

The units definition parameter defines the base unit type (e.g. ohms, Celsius, volts, etc.).

Supported units are:

| Unit Code | Units | Typical Use |
|---|---|---|
| `$00` | °C | Temperature |
| `$01` | Amps | Current |
| `$02` | Angle (degrees) | Angular displacement |
| `$03` | Coulomb | (Electric) charge |
| `$04` | False = 0, True otherwise | Boolean stuff |
| `$05` | Farads | Capacitance |
| `$06` | Henrys | Inductance |
| `$07` | Hertz | Frequency |
| `$08` | Joules | Energy |
| `$09` | Katal | Rate of catalytic activity |
| `$0A` | Kg / m³ | Density |
| `$0B` | Kilograms | Mass |
| `$0C` | Litres | Volume |
| `$0D` | Litres per hour | Very slow flow rates |
| `$0E` | Litres per minute | Slow flow rate |
| `$0F` | Litres per second | Flow rate |
| `$10` | Lux | Light level |
| `$11` | Metres | Distance |
| `$12` | Metres per minute | Slow speed |
| `$13` | Metres per second | Speed |
| `$14` | Metres/s² | Acceleration |
| `$15` | Mole | Quantity of substance |
| `$16` | Newton metre | Torque |
| `$17` | Newtons | Force |
| `$18` | Ohms | Resistance |
| `$19` | Pascal | Pressure |
| `$1A` | Percent | Humidity, generic percentages & linear ratios |
| `$1B` | Decibels | Logarithmic ratio |
| `$1C` | PPM | Concentrations |
| `$1D` | RPM | Angular speed |
| `$1E` | Second | Elapsed Time |
| `$1F` | Minutes | Elapsed Time |
| `$20` | Hours | Elapsed Time |
| `$21` | Sieverts | Radiation |
| `$22` | Steradian | Units of solid angle |
| `$23` | Tesla | Magnetic field strength |
| `$24` | Volts | Voltage |
| `$25` | Watt hours | Power consumption |
| `$26` | Watts | Power |
| `$27` | Webers | Magnetic Flux |
| `$FE` | No units | Unitless quantities |
| `$FF` | Custom | User defined |

### 28.6 Message Priority

C-Bus Measurement Application messages shall always be transmitted at Class 4 (lowest)
priority.

### 28.7 Inter-network Routing

C-Bus Measurement Application Devices may receive Trigger Control Request messages that
have been routed via one or more C-Bus bridges or gateway devices. Such messages will be
received with a message type indicating point-multipoint, but will have a non-zero Network
routing.

In this case, the measurements shall be transmitted into the network that originated the
request. To ensure the response is directed back to the correct network, via the same
bridges and message path, any request messages received with internetwork routing
information shall:

a. Always have the response generated as a point-point-multipoint message; and
b. Use a routing stack derived from the request message, to deliver the response into the
   C-Bus network that originated the request.

### 28.8 Application Behaviour

#### 28.8.1 Concatenated Commands

A Measurement Application device may receive and transmit messages containing more bytes
than a single command. This permits a single C-Bus transmission to contain multiple
commands for a single application.

Devices using C-Bus Measurement messages must process all received bytes. This can be
achieved by placing the received bytes in a buffer, and using the following simple
algorithm:

```
WHILE the buffer contains bytes LOOP
    The first byte defines the command type and argument count (refer section 28.4).
    Process the first (command) byte and its arguments
    Once processed, remove the command and argument bytes from the buffer
END LOOP
```

#### 28.8.2 State

C-Bus Measurement devices are not expected to maintain measurement records through power
failures of the measurement device.

### 28.9 Status Reporting

C-Bus measurement applications shall not respond to C-Bus status requests (MMI).

### 28.10 Limitations

A single C-Bus network should not contain more than 10 measuring devices.

---

Copyright © 2002 – 2007 Clipsal Australia Pty Ltd
