//  SuperTuxKart - a fun racing game with go-kart
//  Copyright (C) 2026 SuperTuxKart-Jev contributors
//
//  This program is free software; you can redistribute it and/or
//  modify it under the terms of the GNU General Public License
//  as published by the Free Software Foundation; either version 3
//  of the License, or (at your option) any later version.

#include "karts/controller/jev_controller.hpp"

#include "config/stk_config.hpp"
#include "items/attachment.hpp"
#include "items/powerup.hpp"
#include "karts/abstract_kart.hpp"
#include "karts/controller/kart_control.hpp"
#include "modes/linear_world.hpp"
#include "modes/world.hpp"
#include "network/stk_ipv6.hpp"
#include "race/race_manager.hpp"
#include "tracks/drive_graph.hpp"
#include "tracks/drive_node.hpp"
#include "tracks/graph.hpp"
#include "tracks/track.hpp"
#include "utils/log.hpp"
#include "utils/time.hpp"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <locale>
#include <sstream>
#include <vector>

bool JevController::s_enabled = false;
int JevController::s_state_port = 19736;
int JevController::s_control_port = 19737;
int JevController::s_telemetry_hz = 10;
int JevController::s_timeout_ms = 2500;
bool JevController::s_waiting_for_start = false;
uint64_t JevController::s_next_session_id = 0;

namespace
{
const char* findValue(const std::string& json, const char* key)
{
    const std::string token = std::string("\"") + key + "\"";
    std::string::size_type pos = json.find(token);
    if (pos == std::string::npos)
        return NULL;
    pos = json.find(':', pos + token.size());
    if (pos == std::string::npos)
        return NULL;
    pos++;
    while (pos < json.size() &&
           (json[pos] == ' ' || json[pos] == '\t' ||
            json[pos] == '\r' || json[pos] == '\n'))
    {
        pos++;
    }
    return pos < json.size() ? json.c_str() + pos : NULL;
}

bool readNumber(const std::string& json, const char* key, double* value)
{
    const char* start = findValue(json, key);
    if (!start)
        return false;
    errno = 0;
    char* end = NULL;
    const double parsed = std::strtod(start, &end);
    if (start == end || errno == ERANGE || !std::isfinite(parsed))
        return false;
    *value = parsed;
    return true;
}

bool readSequence(const std::string& json, uint64_t* value)
{
    const char* start = findValue(json, "sequence");
    if (!start || *start == '-')
        return false;
    errno = 0;
    char* end = NULL;
    const unsigned long long parsed = std::strtoull(start, &end, 10);
    if (start == end || errno == ERANGE)
        return false;
    *value = static_cast<uint64_t>(parsed);
    return true;
}

bool readBool(const std::string& json, const char* key, bool fallback)
{
    const char* start = findValue(json, key);
    if (!start)
        return fallback;
    if (std::string(start, 4) == "true")
        return true;
    if (std::string(start, 5) == "false")
        return false;
    return fallback;
}

bool readString(const std::string& json, const char* key, std::string* value)
{
    const char* start = findValue(json, key);
    if (!start || *start != '"')
        return false;
    start++;
    value->clear();
    while (*start)
    {
        if (*start == '"')
            return true;
        if (*start == '\\')
        {
            start++;
            if (!*start)
                return false;
            switch (*start)
            {
            case '"': value->push_back('"'); break;
            case '\\': value->push_back('\\'); break;
            case '/': value->push_back('/'); break;
            case 'b': value->push_back('\b'); break;
            case 'f': value->push_back('\f'); break;
            case 'n': value->push_back('\n'); break;
            case 'r': value->push_back('\r'); break;
            case 't': value->push_back('\t'); break;
            default: return false;
            }
        }
        else
        {
            value->push_back(*start);
        }
        start++;
    }
    return false;
}

float finiteOrZero(float value)
{
    return std::isfinite(value) ? value : 0.0f;
}

std::string jsonEscape(const std::string& input)
{
    std::ostringstream out;
    for (std::string::const_iterator i = input.begin(); i != input.end(); ++i)
    {
        const unsigned char c = static_cast<unsigned char>(*i);
        switch (c)
        {
        case '\"': out << "\\\""; break;
        case '\\': out << "\\\\"; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20)
            {
                out << "\\u" << std::hex << std::setw(4)
                    << std::setfill('0') << static_cast<int>(c)
                    << std::dec << std::setfill(' ');
            }
            else
            {
                out << *i;
            }
        }
    }
    return out.str();
}

const char* powerupName(PowerupManager::PowerupType type)
{
    switch (type)
    {
    case PowerupManager::POWERUP_BUBBLEGUM: return "bubblegum";
    case PowerupManager::POWERUP_CAKE:      return "cake";
    case PowerupManager::POWERUP_BOWLING:   return "bowling";
    case PowerupManager::POWERUP_ZIPPER:    return "zipper";
    case PowerupManager::POWERUP_PLUNGER:   return "plunger";
    case PowerupManager::POWERUP_SWITCH:    return "switch";
    case PowerupManager::POWERUP_SWATTER:   return "swatter";
    case PowerupManager::POWERUP_RUBBERBALL:return "rubber_ball";
    case PowerupManager::POWERUP_PARACHUTE: return "parachute";
    case PowerupManager::POWERUP_ANVIL:     return "anvil";
    default:                                return "none";
    }
}

struct NearbyKart
{
    float distance;
    float local_x;
    float local_z;
    float speed;
    int position;
};
}

// ----------------------------------------------------------------------------
bool JevController::configure(int state_port, int control_port,
                              int telemetry_hz, int timeout_ms)
{
    if (state_port < 1 || state_port > 65535 ||
        control_port < 1 || control_port > 65535 ||
        state_port == control_port || telemetry_hz < 1 ||
        telemetry_hz > 60 || timeout_ms < 100 || timeout_ms > 30000)
    {
        Log::error("JevController", "Invalid Jev controller configuration.");
        return false;
    }
    s_state_port = state_port;
    s_control_port = control_port;
    s_telemetry_hz = telemetry_hz;
    s_timeout_ms = timeout_ms;
    s_waiting_for_start = true;
    s_enabled = true;
    return true;
}

// ----------------------------------------------------------------------------
JevController::JevController(AbstractKart *kart, int local_player_id,
                             HandicapLevel h)
             : LocalPlayerController(kart, local_player_id, h),
               m_socket(ENET_SOCKET_NULL), m_enet_initialized(false),
               m_socket_ready(false), m_has_command(false),
               m_last_command_ms(0), m_ticks_until_telemetry(0),
               m_track_node(Graph::UNKNOWN_SECTOR),
               m_session_id(++s_next_session_id), m_state_sequence(0),
               m_has_dashboard(false), m_dashboard_lines(8),
               m_has_input_history(false), m_input_history_lines(10)
{
    Controller::setControllerName("JevController");

    if (enet_initialize() != 0)
    {
        Log::error("JevController", "Could not initialize ENet.");
        return;
    }
    m_enet_initialized = true;

    // This integration is intentionally local-only and uses IPv4 loopback.
    setIPv6Socket(0);
    m_socket = enet_socket_create(ENET_SOCKET_TYPE_DATAGRAM);
    if (m_socket == ENET_SOCKET_NULL)
    {
        Log::error("JevController", "Could not create UDP socket.");
        return;
    }
    enet_socket_set_option(m_socket, ENET_SOCKOPT_NONBLOCK, 1);
    enet_socket_set_option(m_socket, ENET_SOCKOPT_REUSEADDR, 1);

    ENetAddress listen_address = {};
    listen_address.port = static_cast<enet_uint16>(s_control_port);
    if (enet_address_set_host_ip(&listen_address, "127.0.0.1") < 0 ||
        enet_socket_bind(m_socket, &listen_address) < 0)
    {
        Log::error("JevController", "Could not bind 127.0.0.1:%d.",
                   s_control_port);
        enet_socket_destroy(m_socket);
        m_socket = ENET_SOCKET_NULL;
        return;
    }

    m_state_address = {};
    m_state_address.port = static_cast<enet_uint16>(s_state_port);
    if (enet_address_set_host_ip(&m_state_address, "127.0.0.1") < 0)
    {
        Log::error("JevController", "Could not resolve loopback address.");
        enet_socket_destroy(m_socket);
        m_socket = ENET_SOCKET_NULL;
        return;
    }

    m_socket_ready = true;
    Log::info("JevController",
              "External control active: telemetry 127.0.0.1:%d, "
              "controls 127.0.0.1:%d.", s_state_port, s_control_port);
}

// ----------------------------------------------------------------------------
JevController::~JevController()
{
    if (m_socket != ENET_SOCKET_NULL)
        enet_socket_destroy(m_socket);
    if (m_enet_initialized)
        enet_deinitialize();
}

// ----------------------------------------------------------------------------
void JevController::reset()
{
    LocalPlayerController::reset();
    s_waiting_for_start = true;
    m_command = Command();
    m_has_command = false;
    m_last_command_ms = 0;
    m_ticks_until_telemetry = 0;
    m_track_node = Graph::UNKNOWN_SECTOR;
    m_session_id = ++s_next_session_id;
    m_state_sequence = 0;
    m_has_dashboard = false;
    m_dashboard_lines.assign(8, std::string());
    m_has_input_history = false;
    m_input_history_lines.assign(10, std::string());
}

// ----------------------------------------------------------------------------
bool JevController::action(PlayerAction action, int value, bool dry_run)
{
    // Keep Escape/pause usable while suppressing keyboard and gamepad driving.
    if (action == PA_PAUSE_RACE)
        return LocalPlayerController::action(action, value, dry_run);
    return false;
}

// ----------------------------------------------------------------------------
void JevController::pollCommands()
{
    if (!m_socket_ready)
        return;

    for (;;)
    {
        char data[8193];
        ENetBuffer buffer;
        buffer.data = data;
        buffer.dataLength = sizeof(data) - 1;
        ENetAddress sender = {};
        const int received = enet_socket_receive(m_socket, &sender, &buffer, 1);
        if (received <= 0)
            break;
        data[received] = '\0';
        const std::string json(data, static_cast<size_t>(received));

        uint64_t sequence = 0;
        double steer = 0.0;
        double accel = 0.0;
        if (!readSequence(json, &sequence) ||
            !readNumber(json, "steer", &steer) ||
            !readNumber(json, "accel", &accel) ||
            (m_has_command && sequence <= m_command.sequence))
        {
            continue;
        }

        m_command.sequence = sequence;
        m_command.steer = static_cast<float>(
            std::max(-1.0, std::min(1.0, steer)));
        m_command.accel = static_cast<float>(
            std::max(0.0, std::min(1.0, accel)));
        m_command.brake = readBool(json, "brake", false);
        m_command.nitro = readBool(json, "nitro", false);
        m_command.drift = readBool(json, "drift", false);
        m_command.rescue = readBool(json, "rescue", false);
        m_command.fire = readBool(json, "fire", false);
        if (m_command.brake)
            m_command.accel = 0.0f;

        bool received_dashboard = false;
        for (unsigned int i = 0; i < m_dashboard_lines.size(); i++)
        {
            std::ostringstream key;
            key << "hud_" << i + 1;
            std::string line;
            if (readString(json, key.str().c_str(), &line))
            {
                m_dashboard_lines[i] = line;
                received_dashboard = true;
            }
        }
        m_has_dashboard = m_has_dashboard || received_dashboard;

        bool received_history = false;
        for (unsigned int i = 0; i < m_input_history_lines.size(); i++)
        {
            std::ostringstream key;
            key << "history_" << i + 1;
            std::string line;
            if (readString(json, key.str().c_str(), &line))
            {
                m_input_history_lines[i] = line;
                received_history = true;
            }
        }
        m_has_input_history = m_has_input_history || received_history;

        m_has_command = true;
        m_last_command_ms = StkTime::getMonoTimeMs();
    }
}

// ----------------------------------------------------------------------------
void JevController::applyCommand()
{
    if (s_waiting_for_start || World::getWorld()->isStartPhase())
    {
        // Holding the safety brake during Ready/Set is interpreted as a false
        // start by PlayerController, so remain neutral until the race begins.
        m_controls->reset();
        return;
    }

    const uint64_t now = StkTime::getMonoTimeMs();
    const bool fresh = m_has_command && now >= m_last_command_ms &&
                       now - m_last_command_ms <=
                           static_cast<uint64_t>(s_timeout_ms);

    if (!fresh)
    {
        m_controls->setSteer(0.0f);
        m_controls->setAccel(0.0f);
        // In SuperTuxKart the brake becomes reverse gear once the kart has
        // stopped. Only hold it while rolling forward, otherwise a slow or
        // missing Jev response would make the kart reverse by itself.
        m_controls->setBrake(m_kart->getSpeed() > 1.0f);
        m_controls->setNitro(false);
        m_controls->setSkidControl(KartControl::SC_NONE);
        m_controls->setRescue(false);
        m_controls->setFire(false);
        return;
    }

    m_controls->setSteer(m_command.steer);
    m_controls->setAccel(m_command.accel);
    // Release the brake before it turns into reverse gear. Jev can request
    // forward acceleration on its next decision to complete a recovery.
    m_controls->setBrake(m_command.brake && m_kart->getSpeed() > 1.0f);
    m_controls->setNitro(m_command.nitro && m_command.accel > 0.0f);
    if (m_command.drift)
    {
        m_controls->setSkidControl(m_command.steer < -0.05f
            ? KartControl::SC_LEFT : (m_command.steer > 0.05f
            ? KartControl::SC_RIGHT : KartControl::SC_NO_DIRECTION));
    }
    else
    {
        m_controls->setSkidControl(KartControl::SC_NONE);
    }
    m_controls->setRescue(m_command.rescue);
    m_controls->setFire(m_command.fire);
}

// ----------------------------------------------------------------------------
void JevController::update(int ticks)
{
    pollCommands();

    // Set controls before the base update so rescue and player-side effects
    // see them, then restore exact analog values after its steering smoother.
    applyCommand();
    LocalPlayerController::update(ticks);
    applyCommand();
    // Rescue and fire are button presses, not modes. Consume them after one
    // physics update even if a bridge accidentally leaves either bit set.
    m_command.rescue = false;
    m_command.fire = false;

    m_ticks_until_telemetry -= ticks;
    if (m_ticks_until_telemetry <= 0)
    {
        sendTelemetry();
        m_ticks_until_telemetry = std::max(1,
            stk_config->time2Ticks(1.0f / static_cast<float>(s_telemetry_hz)));
    }
}

// ----------------------------------------------------------------------------
void JevController::sendTelemetry()
{
    if (!m_socket_ready)
        return;
    const std::string json = makeTelemetry();
    ENetBuffer buffer;
    buffer.data = const_cast<char*>(json.data());
    buffer.dataLength = json.size();
    if (enet_socket_send(m_socket, &m_state_address, &buffer, 1) < 0)
        Log::warn("JevController", "Could not send telemetry datagram.");
}

// ----------------------------------------------------------------------------
std::string JevController::makeTelemetry()
{
    World* world = World::getWorld();
    LinearWorld* linear_world = dynamic_cast<LinearWorld*>(world);
    DriveGraph* graph = DriveGraph::get();
    const int kart_id = m_kart->getWorldKartId();
    const Vec3& xyz = m_kart->getXYZ();
    const btVector3& local_velocity = m_kart->getVelocityLC();
    const btRigidBody* body = m_kart->getBody();
    const float yaw_rate = body
        ? finiteOrZero(body->getAngularVelocity().getY()) : 0.0f;

    bool on_road = false;
    float lateral_offset = 0.0f;
    float distance_down_track = 0.0f;
    float track_width = 0.0f;
    float lap_length = graph ? graph->getLapLength() : 0.0f;

    if (graph && graph->getNumNodes() > 0)
    {
        int found_node = m_track_node;
        graph->findRoadSector(xyz, &found_node);
        on_road = found_node != Graph::UNKNOWN_SECTOR;
        if (!on_road)
            found_node = graph->findOutOfRoadSector(xyz, m_track_node);
        if (found_node != Graph::UNKNOWN_SECTOR)
        {
            m_track_node = found_node;
            Vec3 track_coordinates;
            graph->spatialToTrack(&track_coordinates, xyz, m_track_node);
            lateral_offset = track_coordinates.getX();
            distance_down_track = track_coordinates.getZ();
            track_width = graph->getNode(m_track_node)->getPathWidth();
        }
    }

    if (linear_world)
    {
        lateral_offset = linear_world->getDistanceToCenterForKart(kart_id);
        distance_down_track =
            linear_world->getDistanceDownTrackForKart(kart_id, false);
    }

    const bool off_track = !on_road || (track_width > 0.0f &&
        std::fabs(lateral_offset) > track_width * 0.52f);

    std::vector<NearbyKart> nearby;
    const World::KartList& karts = world->getKarts();
    for (World::KartList::const_iterator i = karts.begin(); i != karts.end(); ++i)
    {
        AbstractKart* other = i->get();
        if (!other || other == m_kart)
            continue;
        const Vec3 local = m_kart->getTrans().inverse()(other->getXYZ());
        NearbyKart item;
        item.local_x = finiteOrZero(local.getX());
        item.local_z = finiteOrZero(local.getZ());
        item.distance = std::sqrt(item.local_x * item.local_x +
                                  item.local_z * item.local_z);
        item.speed = finiteOrZero(other->getSpeed());
        item.position = other->getPosition();
        nearby.push_back(item);
    }
    std::sort(nearby.begin(), nearby.end(),
        [](const NearbyKart& a, const NearbyKart& b)
        {
            return a.distance < b.distance;
        });

    const Powerup* powerup = m_kart->getPowerup();
    const int powerup_count = powerup ? powerup->getNum() : 0;
    const PowerupManager::PowerupType powerup_type = powerup
        ? powerup->getType() : PowerupManager::POWERUP_NOTHING;
    const Attachment* attachment = m_kart->getAttachment();

    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(4);
    out << "{\"type\":\"telemetry\",\"version\":1,\"session\":"
        << m_session_id << ",\"sequence\":" << ++m_state_sequence
        << ",\"race\":{\"time_s\":" << finiteOrZero(world->getTime())
        << ",\"jev_started\":"
        << (s_waiting_for_start ? "false" : "true")
        << ",\"started\":" << (world->isStartPhase() ? "false" : "true")
        << ",\"finished\":" << (world->isFinishPhase() ? "true" : "false")
        << ",\"lap\":" << (linear_world
            ? linear_world->getLapForKart(kart_id) : -1)
        << ",\"laps\":" << RaceManager::get()->getNumLaps()
        << ",\"position\":" << m_kart->getPosition()
        << ",\"kart_count\":" << world->getNumKarts() << "}"
        << ",\"kart\":{\"speed_mps\":" << finiteOrZero(m_kart->getSpeed())
        << ",\"speed_kph\":" << finiteOrZero(m_kart->getSpeed() * 3.6f)
        << ",\"energy\":" << finiteOrZero(m_kart->getEnergy())
        << ",\"heading_rad\":" << finiteOrZero(m_kart->getHeading())
        << ",\"velocity_local_mps\":{\"x\":"
        << finiteOrZero(local_velocity.getX())
        << ",\"z\":" << finiteOrZero(local_velocity.getZ()) << "}"
        << ",\"yaw_rate_rad_s\":" << yaw_rate
        << ",\"on_ground\":" << (m_kart->isOnGround() ? "true" : "false")
        << ",\"animated\":" << (m_kart->getKartAnimation() ? "true" : "false")
        << ",\"xyz\":{\"x\":" << finiteOrZero(xyz.getX())
        << ",\"y\":" << finiteOrZero(xyz.getY())
        << ",\"z\":" << finiteOrZero(xyz.getZ()) << "}"
        << ",\"powerup\":{\"name\":\"" << powerupName(powerup_type)
        << "\",\"count\":" << powerup_count << "}"
        << ",\"attachment_type\":"
        << (attachment ? static_cast<int>(attachment->getType()) : 0)
        << ",\"controls\":{\"steer\":" << m_controls->getSteer()
        << ",\"accel\":" << m_controls->getAccel()
        << ",\"brake\":" << (m_controls->getBrake() ? "true" : "false")
        << ",\"nitro\":" << (m_controls->getNitro() ? "true" : "false")
        << "}}"
        << ",\"track\":{\"name\":\""
        << jsonEscape(Track::getCurrentTrack()->getIdent())
        << "\",\"node\":" << m_track_node
        << ",\"on_road\":" << (on_road ? "true" : "false")
        << ",\"off_track\":" << (off_track ? "true" : "false")
        << ",\"lateral_offset_m\":" << finiteOrZero(lateral_offset)
        << ",\"width_m\":" << finiteOrZero(track_width)
        << ",\"distance_m\":" << finiteOrZero(distance_down_track)
        << ",\"lap_length_m\":" << finiteOrZero(lap_length)
        << ",\"lookahead\":[";

    if (graph && m_track_node != Graph::UNKNOWN_SECTOR)
    {
        const float targets[] = { 5.0f, 12.0f, 22.0f, 35.0f, 50.0f };
        unsigned int target = 0;
        int node = m_track_node;
        float distance = 0.0f;
        bool first = true;
        for (unsigned int step = 0; step < 256 && target < 5; step++)
        {
            DriveNode* current = graph->getNode(node);
            if (current->getNumberOfSuccessors() == 0)
                break;
            distance += current->getDistanceToSuccessor(0);
            node = static_cast<int>(current->getSuccessor(0));
            if (distance < targets[target])
                continue;
            DriveNode* ahead = graph->getNode(node);
            const Vec3 local = m_kart->getTrans().inverse()
                (ahead->getUpperCenter());
            if (!first)
                out << ',';
            first = false;
            out << "{\"distance_m\":" << distance
                << ",\"local_x_m\":" << finiteOrZero(local.getX())
                << ",\"local_z_m\":" << finiteOrZero(local.getZ())
                << ",\"width_m\":" << finiteOrZero(ahead->getPathWidth())
                << '}';
            target++;
        }
    }
    out << "]},\"nearby_karts\":[";
    const size_t nearby_count = std::min<size_t>(nearby.size(), 6);
    for (size_t i = 0; i < nearby_count; i++)
    {
        if (i != 0)
            out << ',';
        out << "{\"distance_m\":" << nearby[i].distance
            << ",\"local_x_m\":" << nearby[i].local_x
            << ",\"local_z_m\":" << nearby[i].local_z
            << ",\"speed_mps\":" << nearby[i].speed
            << ",\"position\":" << nearby[i].position << '}';
    }
    out << "]}";
    return out.str();
}
